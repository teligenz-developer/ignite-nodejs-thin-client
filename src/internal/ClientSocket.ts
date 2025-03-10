/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import * as tls from 'tls';
import * as net from 'net';
const Long = require('long');
import * as Util from 'util';
import BinaryUtils from "./BinaryUtils";

import Logger from "./Logger";
import ArgumentChecker from "./ArgumentChecker";
import BinaryCommunicator from "./BinaryCommunicator";
import MessageBuffer from "./MessageBuffer";
import {NetConnectOpts, Socket } from "net";
import { LostConnectionError, OperationError, IllegalStateError, IgniteClientError } from '../Errors';
import { AffinityTopologyVersion } from './PartitionAwarenessUtils';
import { IgniteClientConfiguration } from "../IgniteClientConfiguration";
import { ConnectionOptions } from 'tls';

const HANDSHAKE_SUCCESS_STATUS_CODE = 1;
const REQUEST_SUCCESS_STATUS_CODE = 0;
const PORT_DEFAULT = 10800;
const FLAG_ERROR = 1;
const FLAG_TOPOLOGY_CHANGED = 2;

class ProtocolVersion {

    private _major: number;

    private _minor: number;

    private _patch: number;

    constructor(major = null, minor = null, patch = null) {
        this._major = major;
        this._minor = minor;
        this._patch = patch;
    }

    compareTo(other) {
        let diff = this._major - other._major;
        if (diff !== 0) {
            return diff;
        }
        diff = this._minor - other._minor;
        if (diff !== 0) {
            return diff;
        }
        return this._patch - other._patch;
    }

    equals(other) {
        return this.compareTo(other) === 0;
    }

    toString() {
        return Util.format('%d.%d.%d', this._major, this._minor, this._patch);
    }

    read(buffer) {
        this._major = buffer.readShort();
        this._minor = buffer.readShort();
        this._patch = buffer.readShort();
    }

    write(buffer) {
        buffer.writeShort(this._major);
        buffer.writeShort(this._minor);
        buffer.writeShort(this._patch);
    }
}

const PROTOCOL_VERSION_1_0_0 = new ProtocolVersion(1, 0, 0);
const PROTOCOL_VERSION_1_1_0 = new ProtocolVersion(1, 1, 0);
const PROTOCOL_VERSION_1_2_0 = new ProtocolVersion(1, 2, 0);
const PROTOCOL_VERSION_1_3_0 = new ProtocolVersion(1, 3, 0);
const PROTOCOL_VERSION_1_4_0 = new ProtocolVersion(1, 4, 0);

const SUPPORTED_VERSIONS = [
    // PROTOCOL_VERSION_1_0_0, // Support for QueryField precision/scale fields breaks 1.0.0 compatibility
    PROTOCOL_VERSION_1_1_0,
    PROTOCOL_VERSION_1_2_0,
    PROTOCOL_VERSION_1_3_0,
    PROTOCOL_VERSION_1_4_0
];

const CURRENT_VERSION = PROTOCOL_VERSION_1_4_0;

export enum STATE {
    INITIAL = 0,
    HANDSHAKE = 1,
    CONNECTED = 2,
    DISCONNECTED = 3
}

export default class ClientSocket {

    private _socket: Socket;

    private _host: string;

    private _buffer: MessageBuffer;

    private _requests: Map<string, Request>;

    private _nodeUuid: string;

    private _error: string | Error;

    private _endpoint: string;
    private _config: IgniteClientConfiguration;
    private _communicator: BinaryCommunicator;
    private _onSocketDisconnect: Function;
    private _onAffinityTopologyChange: Function;
    private _state: STATE;
    private _requestId: Long;
    private _offset: number;
    private _wasConnected: boolean;
    private _handshakeRequestId: Long;
    private _protocolVersion: ProtocolVersion;
    private _port: number | string;
    private _version: number;

    constructor(endpoint: string, config: IgniteClientConfiguration, communicator: BinaryCommunicator, onSocketDisconnect: Function, onAffinityTopologyChange: Function) {
        ArgumentChecker.notEmpty(endpoint, 'endpoints');
        this._endpoint = endpoint;
        this._parseEndpoint(endpoint);
        this._config = config;
        this._communicator = communicator;
        this._onSocketDisconnect = onSocketDisconnect;
        this._onAffinityTopologyChange = onAffinityTopologyChange;

        this._state = STATE.INITIAL;
        this._requests = new Map<string, Request>();
        this._requestId = Long.ZERO;
        this._handshakeRequestId = null;
        this._protocolVersion = null;
        this._wasConnected = false;
        this._socket = null;
        this._buffer = null;
        this._offset = 0;
        this._error = null;

        this._nodeUuid = null;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this._connectSocket(
                this._getHandshake(CURRENT_VERSION, resolve, reject));
        });
    }

    disconnect() {
        this._disconnect(true, false);
    }

    get requestId() {
        const id = this._requestId;
        this._requestId = this._requestId.add(1);
        return id;
    }

    get endpoint() {
        return this._endpoint;
    }

    get nodeUUID() {
        return this._nodeUuid;
    }

    async sendRequest(opCode, payloadWriter, payloadReader = null) {
        if (this._state === STATE.CONNECTED) {
            return new Promise(async (resolve, reject) => {
                const request = new Request(this.requestId, opCode, payloadWriter, payloadReader, resolve, reject);
                this._addRequest(request);
                await this._sendRequest(request);
            });
        }
        else {
            throw new IllegalStateError(this._state);
        }
    }

    _connectSocket(handshakeRequest) {
        const onConnected = async () => {
            this._state = STATE.HANDSHAKE;
            // send handshake
            await this._sendRequest(handshakeRequest);
        };

        const options: (NetConnectOpts | ConnectionOptions) = Object.assign({},
            this._config.options,
            { host : this._host, port : this._port, version : this._version });

        if (this._config.useTLS) {
            this._socket = tls.connect(<ConnectionOptions>options, onConnected);
        }
        else {
            this._socket = net.createConnection(<NetConnectOpts>options, onConnected);
        }

        this._socket.on('data', async (data: Buffer) => {
            try {
                await this._processResponse(data);
            }
            catch (err) {
                this._error = err.message;
                this._disconnect();
            }
        });
        this._socket.on('close', () => {
            this._disconnect(false);
        });
        this._socket.on('error', (error) => {
            this._error = this._state === STATE.INITIAL ?
                'Connection failed: ' + error : error;
            this._disconnect();
        });
    }

    _addRequest(request: Request) {
        this._requests.set(request.id.toString(), request);
    }

    async _sendRequest(request: Request) {
        try {
            const message = await request.getMessage();
            this._logMessage(request.id.toString(), true, message);
            this._socket.write(message);
        }
        catch (err) {
            this._requests.delete(request.id.toString());
            request.reject(err);
        }
    }

    async _processResponse(message: Buffer) {
        if (this._state === STATE.DISCONNECTED) {
            return;
        }

        if (this._buffer) {
            this._buffer.concat(message);
            this._buffer.position = this._offset;
        }
        else {
            this._buffer = MessageBuffer.from(message, 0);
        }

        while (this._buffer && this._offset < this._buffer.length) {
            const buffer = this._buffer;
            // Response length
            const length = buffer.readInteger() + BinaryUtils.getSize(BinaryUtils.TYPE_CODE.INTEGER);

            if (buffer.length < this._offset + length) {
              break;
            }
            this._offset += length;

            let requestId;
            const isHandshake = this._state === STATE.HANDSHAKE;

            if (isHandshake) {
                // Handshake status
                requestId = this._handshakeRequestId.toString();
            }
            else {
                // Request id
                requestId = buffer.readLong().toString();
            }

            this._logMessage(requestId, false, buffer.getSlice(this._offset - length, length));

            let startindex = this._offset - length;
            let endindex = this._offset;
            let resBufferPosition = buffer._position - startindex; // From where the new buffer will start processing response

            const single_response_buffer = MessageBuffer_1.default.from(buffer.getSlice(startindex, endindex), resBufferPosition); // Create new buffer with single response
            buffer._position = this._offset; // Make position as offset to process new response


            if (this._offset === buffer.length) {
                this._buffer = null;
                this._offset = 0;
            }

            if (this._requests.has(requestId)) {
                const request = this._requests.get(requestId);
                this._requests.delete(requestId);
                if (isHandshake) {
                    await this._finalizeHandshake(single_response_buffer, request);
                }
                else {
                    await this._finalizeResponse(single_response_buffer, request);
                }
            }
            else {
                throw IgniteClientError.internalError('Invalid response id: ' + requestId);
            }
        }
    }

    async _finalizeHandshake(buffer: MessageBuffer, request: Request) {
        const isSuccess = buffer.readByte() === HANDSHAKE_SUCCESS_STATUS_CODE;

        if (!isSuccess) {
            // Server protocol version
            const serverVersion = new ProtocolVersion();
            serverVersion.read(buffer);
            // Error message
            const errMessage = BinaryCommunicator.readString(buffer);

            if (!this._protocolVersion.equals(serverVersion)) {
                if (!this._isSupportedVersion(serverVersion) ||
                    serverVersion.compareTo(PROTOCOL_VERSION_1_1_0) < 0 && this._config.userName) {
                    request.reject(new OperationError(
                        Util.format('Protocol version mismatch: client %s / server %s. Server details: %s',
                            this._protocolVersion.toString(), serverVersion.toString(), errMessage)));
                    this._disconnect();
                }
                else {
                    // retry handshake with server version
                    const handshakeRequest = this._getHandshake(serverVersion, request.resolve, request.reject);
                    await this._sendRequest(handshakeRequest);
                }
            }
            else {
                request.reject(new OperationError(errMessage));
                this._disconnect();
            }
        }
        else {
            if (this._protocolVersion.compareTo(PROTOCOL_VERSION_1_4_0) >= 0) {
                this._nodeUuid = await this._communicator.readObject(buffer, BinaryUtils.TYPE_CODE.UUID);
            }

            this._state = STATE.CONNECTED;
            this._wasConnected = true;
            request.resolve();
        }
    }

    async _finalizeResponse(buffer: MessageBuffer, request: Request) {
        let statusCode, isSuccess;

        if (this._protocolVersion.compareTo(PROTOCOL_VERSION_1_4_0) < 0) {
            // Check status code
            statusCode = buffer.readInteger();
            isSuccess = statusCode === REQUEST_SUCCESS_STATUS_CODE;
        }
        else {
            // Check flags
            let flags = buffer.readShort();
            isSuccess = !(flags & FLAG_ERROR);

            if (flags & FLAG_TOPOLOGY_CHANGED) {
                const newVersion = new AffinityTopologyVersion(buffer);
                await this._onAffinityTopologyChange(newVersion);
            }

            if (!isSuccess) {
                statusCode = buffer.readInteger();
            }
        }

        if (!isSuccess) {
            // Error message
            const errMessage = BinaryCommunicator.readString(buffer);
            request.reject(new OperationError(errMessage));
        }
        else {
            try {
                if (request.payloadReader) {
                    await request.payloadReader(buffer);
                }
                request.resolve();
            }
            catch (err) {
                request.reject(err);
            }
        }
    }

    async _handshakePayloadWriter(payload) {
        // Handshake code
        payload.writeByte(1);
        // Protocol version
        this._protocolVersion.write(payload);
        // Client code
        payload.writeByte(2);
        if (this._config.userName) {
            BinaryCommunicator.writeString(payload, this._config.userName);
            BinaryCommunicator.writeString(payload, this._config.password);
        }
    }

    _getHandshake(version: ProtocolVersion, resolve: Function, reject: Function) {
        this._protocolVersion = version;
        const handshakeRequest = new Request(
            this.requestId, null, this._handshakePayloadWriter.bind(this), null, resolve, reject);
        this._addRequest(handshakeRequest);
        this._handshakeRequestId = handshakeRequest.id;
        return handshakeRequest;
    }

    _isSupportedVersion(protocolVersion) {
        for (let version of SUPPORTED_VERSIONS) {
            if (version.equals(protocolVersion)) {
                return true;
            }
        }
        return false;
    }

    _disconnect(close = true, callOnDisconnect = true) {
        this._state = STATE.DISCONNECTED;
        this._requests.forEach((request, id) => {
            request.reject(new LostConnectionError(this._error));
            this._requests.delete(id);
        });
        if (this._wasConnected && callOnDisconnect && this._onSocketDisconnect) {
            this._onSocketDisconnect(this, this._error);
        }
        if (close) {
            this._onSocketDisconnect = null;
            this._socket.end();
        }
    }

    _parseEndpoint(endpoint) {
        endpoint = endpoint.trim();
        this._host = endpoint;
        this._port = null;
        const colonCnt = endpoint.split(':').length - 1;
        if (colonCnt > 1) {
            // IPv6 address
            this._version = 6;
            const index = endpoint.lastIndexOf(']:');
            if (index >= 0) {
                this._host = endpoint.substring(0, index + 1);
                this._port = endpoint.substring(index + 2);
            }
            if (this._host.startsWith('[') || this._host.endsWith(']')) {
                if (this._host.startsWith('[') && this._host.endsWith(']')) {
                    this._host = this._host.substring(1, this._host.length - 1);
                }
                else {
                    throw IgniteClientError.illegalArgumentError('Incorrect endpoint format: ' + endpoint);
                }
            }
        }
        else {
            // IPv4 address
            this._version = 4;
            const index = endpoint.lastIndexOf(':');
            if (index >= 0) {
                this._host = endpoint.substring(0, index);
                this._port = endpoint.substring(index + 1);
            }
        }
        if (!this._port) {
            this._port = PORT_DEFAULT;
        }
        else {
            this._port = parseInt(<string>this._port);
            if (isNaN(this._port)) {
                throw IgniteClientError.illegalArgumentError('Incorrect endpoint format: ' + endpoint);
            }
        }
    }

    _logMessage(requestId, isRequest, message) {
        if (Logger.debug) {
            Logger.logDebug((isRequest ? 'Request: ' : 'Response: ') + requestId);
            Logger.logDebug('[' + [...message] + ']');
        }
    }
}

class Request {
    private _id: Long;
    private _resolve: Function;
    private _reject: Function;
    private _payloadWriter: Function;
    private _opCode: number;
    private _payloadReader: Function;
    constructor(id: Long, opCode, payloadWriter, payloadReader, resolve: Function, reject: Function) {
        this._id = id;
        this._opCode = opCode;
        this._payloadWriter = payloadWriter;
        this._payloadReader = payloadReader;
        this._resolve = resolve;
        this._reject = reject;
    }

    get id(): Long {
        return this._id;
    }

    get payloadReader() {
        return this._payloadReader;
    }

    get resolve() {
        return this._resolve;
    }

    get reject() {
        return this._reject;
    }

    async getMessage() {
        const message = new MessageBuffer();
        // Skip message length
        const messageStartPos = BinaryUtils.getSize(BinaryUtils.TYPE_CODE.INTEGER);
        message.position = messageStartPos;
        if (this._opCode !== null) {
            // Op code
            message.writeShort(this._opCode);
            // Request id
            message.writeLong(this._id);
        }
        if (this._payloadWriter) {
            // Payload
            await this._payloadWriter(message);
        }
        // Message length
        message.position = 0;
        message.writeInteger(message.length - messageStartPos);
        return message.data;
    }
}
