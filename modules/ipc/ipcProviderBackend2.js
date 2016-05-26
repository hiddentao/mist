"use strict";

/**
The IPC provider backend filter and tunnel all incoming request to the ethereum node.

@module ipcProviderBackend
*/

const _ = global._;
const Q = require('bluebird');
const electron = require('electron');
const ipc = electron.ipcMain;

const log = require('../utils/logger').create('ipcProviderBackend');
const ipcPath = require('getIpcPath')();
const Sockets = require('../sockets');
const ethereumNode = require('../ethereumNode');



const JSON_ERRORS = {
    METHOD_DENIED: {"jsonrpc": "2.0", "error": {"code": -32601, "message": "Method \'__method__\' not allowed."}, "id": "__id__"},
    METHOD_TIMEOUT: {"jsonrpc": "2.0", "error": {"code": -32603, "message": "Request timed out for method  \'__method__\'."}, "id": "__id__"},
    TX_DENIED: {"jsonrpc": "2.0", "error": {"code": -32603, "message": "Transaction denied"}, "id": "__id__"},
    BATCH_TX_DENIED: {"jsonrpc": "2.0", "error": {"code": -32603, "message": "Transactions denied, sendTransaction is not allowed in batch requests."}, "id": "__id__"},
    INVALID_METHOD: {"jsonrpc": "2.0", "method": "eth_nonExistingMethod", "params": [],"id": "__id__"},
};



/**
 * IPC provider backend.
 */
class IpcProviderBackend {
    constructor () {
        this._connections = {};

        ethereumNode.on('state', _.bind(this._onNodeStateChanged, this));

        ipc.on('ipcProvider-create', _.bind(this._createConnection, this));
        ipc.on('ipcProvider-destroy', _.bind(this._destroyConnection, this));
        ipc.on('ipcProvider-write', _.bind(this._sendRequest, this, false));
        ipc.on('ipcProvider-writeSync', _.bind(this._sendRequest, this, true));
    }


    /**
     * Handle IPC call to create new connection.
     */
    _createConnection (event) {
        const id = event.sender.getId();

        // get the actual window instance for this sender
        const wnd = Windows.getById(id);

        if (!wnd) {
            return log.error(`Unable to find window ${id}`);
        }

        // get or create a new socket
        const socket = Sockets.get(wnd.id, Sockets.TYPES.WEB3_IPC);

        return Q.try(() => {
            if (!socket.isConnected) {
                return socket.connect({
                    path: ipcPath,
                }, {
                    timeout: 5000,
                });
            }
        })
        .then(() => {
            // save to collection
            this._connections[wnd.id] = {
                owner: wnd,
                socket: socket,
            };

            // if something goes wrong destroy the socket
            ['error', 'timeout', 'end'].forEach((ev) => {
                socket.on(ev, (data) => {
                    socket.destroy().finally(() => {
                        delete Connections[wnd.id];
                        
                        wnd.send(`ipcProvider-${ev}`, data);
                    });
                });                
            });

            return this._connections[wnd.id];
        });
    }


    /**
     * Handle IPC call to destroy a connection.
     */
    _destroyConnection (event) {
        const id = event.sender.getId();

        return Q.try(() => {
            if (this._connections[id]) {
                return this._connections[id].socket.destroy().finally({
                    delete this._connections[id];
                });
            }            
        });
    }


    /**
     * Handler for when Ethereum node state changes.
     *
     * Auto-reconnect sockets when ethereum node state changes
     *
     * @param {String} state The new state.
     */
    _onNodeStateChanged (state) {
        switch (state) {
            // stop syncing when node about to be stopped
            case ethereumNode.STATES.STOPPING:
                log.info('Ethereum node stopping, disconnecting sockets');

                Q.map(this._connections, (item) => {
                    log.debug(`Tell owner (${item.sender.getId()}) that socket is not currently writeable`);

                    item.owner.send('ipcProvider-setWritable', false);

                    return item.socket.disconnect();
                })
                .catch((err) => {
                    log.error('Error disconnecting sockets', err);
                });

                break;
            // auto-sync whenever node gets connected
            case ethereumNode.STATES.CONNECTED:
                log.info('Ethereum node connected, re-connect sockets');

                Q.map(this._connections, (item) => {
                    item.socket.connect({ path: ipcPath}, {timeout: 5000})
                        .then(() => {
                            log.debug(`Tell owner (${item.sender.getId()}) that socket is again writeable`);

                            item.owner.send('ipcProvider-setWritable', true);
                        });
                })
                .catch((err) => {
                    log.error('Error re-connecting sockets', err);
                });

                break;
        }
    }

    /**
     * Handle IPC call to send a request.
     * @param  {Boolean} isSync  whether request is sync.
     * @param  {[type]}  event   IPC event.
     * @param  {[type]}  payload request payload.
     */
    _sendRequest (isSync, event, payload) {
        log.trace('sendRequest', isSync ? 'sync' : 'async', event.sender.getId(), payload);

        Q.try(() => {
            let conn = this._connections[event.sender.getId()];

            if (!conn) {
                return this._createConnection(event);
            }            

            return conn;
        })
        .then((conn) => {
            let jsonPayload = JSON.parse(payload);

            if (!conn.socket.isConnected) {
                log.trace('Socket not connected.');

                throw this._returnError(jsonPayload, JSON_ERRORS.METHOD_TIMEOUT);
            }

            filteredPayload = this._filterRequestResponse(conn, jsonPayload);


        })
        .catch((err) => {
            log.error('Send request failed', err);

            if (isSync) {
                event.returnValue = JSON.stringify(err);
            } else {
                event.sender.send('ipcProvider-data', err);
            }
        })

    }


    /**
    Filter requests and responses.

    @method filterRequestResponse
    @param {Object} connection The connection.
    @param {Object} requestPayload The request payload.
    @param {Object} responsePayload The response payload.
    @return {Boolean} TRUE when its a valid allowed request, otherWise FALSE
    */
    _filterRequestResponse (connection, requestPayload, responsePayload) {
        if(!_.isObject(requestPayload)) {
            return false;
        }

        let wnd = connection.owner;

        // main window or popupwindows - always allow requests
        if ('main' === wnd.type || wnd.isPopup) {
            return requestPayload;
        }

        if(_.isArray(requestPayload)) {
            return _.map(requestPayload, (load) => {
                let req = event ? _.find(event.requestPayload, function(re){
                    return (re.id === load.id);
                }) : false;

                return _this.testPayload(load, (load.result ? errorMethod : nonExistingRequest), (req ? req.method : false));
            });
        } else {
            return this.testPayload(jsonPayload, (jsonPayload.result ? errorMethod : false), (event ? event.jsonPayload.method : false));
        }

    }


    /**
    Make the error response object.

    @method makeError
    */
    _makeError (payload, error) {
        if(error.error)
            error.error.message = error.error.message.replace(/'[a-z_]*'/i, "'"+ payload.method +"'");
        error.id = payload.id;

        return error;
    }

    /**
    Make the retrun response object.

    @method makeReturnValue
    */
    _makeReturnValue (payload, value) {
        var result = {"jsonrpc": "2.0"};
        if(value)
            result.result = value;
        result.id = payload.id;

        return result;
    }

    /**
    Make the error response object for either an error or an batch array of errors

    @method returnError
    */
    _returnError (payload, error) {
        if(_.isArray(payload)) {
            return _.map(payload, function(load){
                return this._makeError(load, error);
            });
        } else {
            return this._makeError(payload, error);
        }
    }

    /**
    Make the return response object

    @method returnValue
    */
    _returnValue (payload, value) {
        if(_.isArray(payload)) {
            return _.map(payload, function(load){
                return this._makeReturnValue(load, value);
            });
        } else {
            return this._makeReturnValue(payload, value);
        }
    }

}



exports.init = function() {
    return new IpcProviderBackend();
};






var dechunker = require('./dechunker.js');
const _ = global._;

const Windows = require('../windows');

const logger = require('../utils/logger');

const log = logger.create('ipcProviderBackend');


/**
make sockets globally available

@property global.sockets
*/
global.sockets = {};


module.exports = function(){
    const _ = require('underscore');
    const ipc = electron.ipcMain;
    const net = require('net');
    const Socket = net.Socket;
    const getIpcPath = require('./getIpcPath.js');


    var errorMethod = {"jsonrpc": "2.0", "error": {"code": -32601, "message": "Method \'__method__\' not allowed."}, "id": "__id__"},
        errorTimeout = {"jsonrpc": "2.0", "error": {"code": -32603, "message": "Request timed out for method  \'__method__\'."}, "id": "__id__"},
        errorUnlock = {"jsonrpc": "2.0", "error": {"code": -32603, "message": "Transaction denied"}, "id": "__id__"},
        errorSendTxBatch = {"jsonrpc": "2.0", "error": {"code": -32603, "message": "Transactions denied, sendTransaction is not allowed in batch requests."}, "id": "__id__"},
        nonExistingRequest = {"jsonrpc": "2.0", "method": "eth_nonExistingMethod", "params": [],"id": "__id__"},
        ipcPath = getIpcPath();


    /**
    Make the error response object.

    @method makeError
    */
    var makeError = function(payload, error) {
        if(error.error)
            error.error.message = error.error.message.replace(/'[a-z_]*'/i, "'"+ payload.method +"'");
        error.id = payload.id;

        return error;
    };

    /**
    Make the error response object for either an error or an batch array of errors

    @method returnError
    */
    var returnError = function(payload, error) {
        if(_.isArray(payload)) {
            return _.map(payload, function(load){
                return makeError(load, error);
            });
        } else {
            return makeError(payload, error);
        }
    };


    /**
    The IPC wrapper backend, handling one socket connection per view

    @class GethConnection
    @constructor
    */
    var GethConnection = function(event) {
        this.ipcSocket = new Socket();
        this.path = ipcPath;
        this.syncEvents = {};
        this.asyncEvents = {};


        this.sender = event.sender;
        this.id = event.sender.getId();

        this.ipcSocket.setEncoding('utf8');
        this.ipcSocket.setTimeout(0); // disable
        // this.ipcSocket.setKeepAlive(true, 1000 * 10);
        // this.ipcSocket.setNoDelay(false);

        // setup socket
        this.connect(event);
        this.setupSocket();

        return this;
    };


    /**
    Connects to a socket
    @method connect
    */
    GethConnection.prototype.connect = function(event){
        var _this = this,
            timeoutId,
            successEventFunc,
            errorEventFunc;

        if(!this.ipcSocket.writable) {

            // log.info('IPCSOCKET '+ this.id +' CONNECTING..');

            this.ipcSocket = this.ipcSocket.connect({path: this.path});

            // make sure to set the right writeable
            successEventFunc = function(){
                if(event && timeoutId) {
                    clearTimeout(timeoutId);
                    event.returnValue = true;
                }
                
                _this.ipcSocket.removeListener('error', errorEventFunc);
            };
            this.ipcSocket.once('connect', successEventFunc);

            errorEventFunc = function(){
                if(event && timeoutId) {
                    clearTimeout(timeoutId);
                    event.returnValue = false;
                }
             
                _this.ipcSocket.removeListener('connect', successEventFunc);
            };
            this.ipcSocket.once('error', errorEventFunc);


            // return if it takes to long
            if(event) {
                timeoutId = setTimeout(function(){
                    event.returnValue = _this.ipcSocket.writable;
                    timeoutId = null;
                }, 500);
            }
        
        } else if(event) {
            event.returnValue = true;

        } else {
            this.sender.send('ipcProvider-setWritable', true);
        }

    };

    /**
    Creates the socket and sets up the listeners.

    @method setupSocket
    */
    GethConnection.prototype.setupSocket = function() {
        var _this = this;
        

        this.ipcSocket.on('connect', function(data){
            _this.sender.send('ipcProvider-setWritable', true);
            _this.sender.send('ipcProvider-connect', data);
        });

        // wait for data on the socket
        this.ipcSocket.on('data', function(data){
            dechunker(data, function(error, result){

                if (error) {
                    log.error('IPCSOCKET '+ _this.id +' TIMEOUT ERROR', error);
                    _this.timeout();
                    return;
                }

                // FILTER RESPONSES
                var event = _this.getResponseEvent(result);

                // if notification, then send it back to the creator of this socket
                if(!event)
                    return _this.sender.send('ipcProvider-data', JSON.stringify(result));

                result = _this.filterRequestResponse(result, event);

                // if(result && !_.isArray(result))
                if(!result.id && !_.isArray(result))
                    log.debug('IPCSOCKET '+ _this.sender.getId()  +' NOTIFICATION', event.payload, result, "\n\n");

                // SEND SYNC back
                if(event.sync) {
                    if(!event.sender.isDestroyed())
                        event.returnValue = JSON.stringify(result);
                    delete _this.syncEvents[event.eventId];

                // SEND async back
                } else {
                    if(!event.sender.isDestroyed())
                        event.sender.send('ipcProvider-data', JSON.stringify(result));
                    delete _this.asyncEvents[event.eventId];
                }
            });
        });


        this.ipcSocket.on('error', function(data){
            try {
                log.info('IPCSOCKET '+ _this.id +' ERROR', data);

                var id = _this.sender.getId(); // will throw an error, if webview is already closed

                _this.sender.send('ipcProvider-error', data);

            } catch(e) {
                _this.destroy();
            }
        });

        // this.ipcSocket.on('drain', function(data){
        //     log.info('IPCSOCKET '+ _this.sender.getId() +' DRAINED');
        // });

        this.ipcSocket.on('timeout', function(data){
            try {
                log.info('IPCSOCKET '+ _this.id +' TIMEDOUT', data);

                var id = _this.sender.getId(); // will throw an error, if webview is already closed

                _this.sender.send('ipcProvider-timeout', data);
                _this.destroy();

            } catch(e) {
            }
        });

        this.ipcSocket.on('end', function(data){
            try {
                log.debug('IPCSOCKET '+ _this.id +' CONNECTION ENDED', data, _this.ipcSocket.writable);

                var id = _this.sender.getId(); // will throw an error, if webview is already closed

                _this.sender.send('ipcProvider-end', data);
                _this.destroy();

            } catch(e) {
            }
        });

    };

    /**
    Filter requests and responses.

    @method getResponseEvent
    @param {Object} response
    @return {Boolean} TRUE when its a valid allowed request, otherWise FALSE
    */
    GethConnection.prototype.getResponseEvent = function(response) {
        var _this = this;

        if(_.isArray(response)) {
            response = _.find(response, function(load){
                return _this.syncEvents[load.id] || _this.asyncEvents[load.id];
            });
        }


        return (response) ? this.syncEvents[response.id] || this.asyncEvents[response.id] : false;
    };


    /**
    Filter Request and responses filter

    @method testPayload
    @param {Object} payload
    @param {Object} error
    @param {Object} method
    @return {Mixed} The filtered object, an error or false, if forbidden and no error was given.
    */
    GethConnection.prototype.testPayload = function(payload, error, method){

        // Is already ERROR
        if(payload.error) {
            return payload;

        // FILTER REQUESTS
        } else if(payload.method) {

            // prevent dapps from acccesing admin endpoints
            if(!/^eth_|^shh_|^net_|^web3_|^db_/.test(payload.method)){
                payload = error ? returnError(payload, error) : false;
            }

        // FILTER RESULTS
        } else if(payload.result) {

            // stop if no method was given
            if(!method)
                return error ? returnError(payload, error) : false;


            var tab = Tabs.findOne({webviewId: this.id});

            // filter accounts, to allow only allowed accounts
            if(method === 'eth_accounts') {
                if(tab && tab.permissions && tab.permissions.accounts) {
                    payload.result = _.intersection(payload.result, tab.permissions.accounts);
                } else {
                    payload.result = [];
                }
            }
        }

        return payload;
    };

    /**
    Filter requests and responses.

    @method filterRequestResponse
    @param {Object} payload
    @param {Object} event
    @return {Boolean} TRUE when its a valid allowed request, otherWise FALSE
    */
    GethConnection.prototype.filterRequestResponse = function(payload, event) {
        var _this = this;

        if(!_.isObject(payload))
            return false;

        // main window or popupwindows are admin
        let mainWindow = Windows.getByType('main'),
            thisWindow = Windows.getById(this.id);

        if(mainWindow && this.id === mainWindow.id ||
           (thisWindow && thisWindow.type && thisWindow.type !== 'webview')) {
            return payload;
        }

        if(_.isArray(payload)) {
            return _.map(payload, function(load){
                var req = event ? _.find(event.payload, function(re){
                    return (re.id === load.id);
                }) : false;
                return _this.testPayload(load, (load.result ? errorMethod : nonExistingRequest), (req ? req.method : false));
            });
        } else {
            return this.testPayload(payload, (payload.result ? errorMethod : false), (event ? event.payload.method : false));
        }

    };


    /**
    Checks whether the payload is a send transaction and if asks for password or confirmation

    @method checkRequests
    @param {Object} filteredPayload
    @param {Object} event   the ipc sender event
    @param {Function} callback returns {Object|Boolean} the filteres payload or FALSE
    */
    GethConnection.prototype.checkRequests = function(filteredPayload, event, callback){
        var _this = this;
        var called = false;

        // batch request can't unlock for now (they might be deprecated soon) 
        if(_.isArray(filteredPayload)) {
            if(_.find(filteredPayload, function(payload){ return (payload.method === 'eth_sendTransaction'); }))
                return callback(errorSendTxBatch);
            else
                return callback(null, filteredPayload);
        }


        // confirm SEND TRANSACTION
        if(filteredPayload.method === 'eth_sendTransaction') {
            log.debug('Send transaction');

            var modalWindow = Windows.createPopup('sendTransactionConfirmation', {
                sendData: ['data', filteredPayload.params[0]],
                electronOptions: {
                    width: 580, 
                    height: 550, 
                    alwaysOnTop: true,
                },
            });

            modalWindow.on('closed', function() {
                if(!called) {
                    callback(errorUnlock);
                    called = true;
                }
            });

            ipc.once('backendAction_unlockedAccount', function(ev, err, result){
                if(modalWindow.webContents && ev.sender.getId() === modalWindow.id) {
                    if(err || !result) {
                        log.info('Confirmation error:', err);

                        // return error, to stop sending the request
                        if(!called) {
                            callback(errorUnlock);
                        }

                    } else {
                        // set the changed provided gas
                        filteredPayload.params[0].gas = result;

                        log.info('Confirmed transaction on socket '+ _this.id +':', filteredPayload.params[0]);
                        if(!called) {
                            callback(null, filteredPayload);
                        }
                    }

                    called = true;
                    modalWindow.close();
                    modalWindow = null;
                }
            });

        // COMPILE SOLIDITY
        } else if(filteredPayload.method === 'eth_compileSolidity') {
            log.debug('Compile solidity');

            var solc = require('solc');

            var output = solc.compile(filteredPayload.params[0], 1); // 1 activates the optimiser

            var response = (!output || output.errors)
                ? {"jsonrpc": "2.0", "error": {code: -32700, message: (output ? output.errors : 'Compile error')}, "id": filteredPayload.id}
                : {"jsonrpc": "2.0", "result": output.contracts, "id": filteredPayload.id};

            if(event.sync)
                event.returnValue = JSON.stringify(response);
            else
                event.sender.send('ipcProvider-data', JSON.stringify(response));

            // return error, to stop sending the request
            callback(true);
            solc = null;

        } else {
            return callback(null, filteredPayload);
        }

    };

    /**
    Sends a timeout error for all still waiting responses

    @method timeout
    */
    GethConnection.prototype.timeout = function() {
        var _this = this;
        
        if(!this.sender.isDestroyed())
            this.sender.send('ipcProvider-setWritable', _this.ipcSocket.writable);

        // cancel all requests
        _.each(this.asyncEvents, function(event, key){
            if(!event.sender.isDestroyed())
                event.sender.send('ipcProvider-data', JSON.stringify(returnError(event.payload, errorTimeout)));
            delete _this.asyncEvents[key];
        });
        _.each(this.syncEvents, function(event, key){
            if(!event.sender.isDestroyed())
                event.returnValue = JSON.stringify(returnError(event.payload, errorTimeout));
            delete _this.syncEvents[key];
        });
    };

    /**
    This will close the socket connection and prevent any further activity with it.

    @method destroy
    */
    GethConnection.prototype.destroy = function() {
        if(!this || !this.ipcSocket)
            return;

        this.timeout();
        
        this.ipcSocket.removeAllListeners();
        this.ipcSocket.destroy();

        log.debug('SOCKET '+ this.id + ' DESTROYED!');

        if(global.sockets['id_'+ this.id])
            delete global.sockets['id_'+ this.id];
    };



    /**
    The IPC listeners

    @class ipcProvider Backend
    @constructor
    */

    // wait for incoming requests from dapps/ui
    ipc.on('ipcProvider-create', function(event){
        var socket = global.sockets['id_'+ event.sender.getId()];

        // log.info('Called ipcProvider-create');

        if(socket) {
            socket.connect(event);
        } else {
            socket = global.sockets['id_'+ event.sender.getId()] = new GethConnection(event);
        }

      
        if(event.sender.returnValue)
            event.sender.returnValue = socket.ipcSocket.writable;      
        // else       
        //     event.sender.send('ipcProvider-setWritable', socket.ipcSocket.writable);
    });

    ipc.on('ipcProvider-destroy', function(event){
        var socket = global.sockets['id_'+ event.sender.getId()];
        if(!socket) return;

        // log.info('Called ipcProvider-destroy');

        if(socket) {
            socket.destroy();
        }
    });


    var sendRequest = function(event, payload, sync) {
        log.trace('sendRequest', event.sender.getId(), payload, sync);

        var socket = global.sockets['id_'+ event.sender.getId()];

        if(!socket) {
            log.trace('Create socket');

            // TODO: should we really try to reconnect, after the connection was destroyed?
            socket = global.sockets['id_'+ event.sender.getId()] = new GethConnection(event);
        // make sure we are connected
        } else if(!socket.ipcSocket.writable) {
            log.trace('Ensure socket is connected');

            socket.connect(event);
        }

        // if not writeable send error back
        if(!socket.ipcSocket.writable) {
            log.trace('Socket not writeable');

            if(event.sync)
                event.returnValue = JSON.stringify(returnError(jsonPayload, errorTimeout));
            else
                event.sender.send('ipcProvider-data', JSON.stringify(returnError(jsonPayload, errorTimeout)));
            return;
        }

        // log.info('SEND REQ', event.sender.getId());

        var jsonPayload = JSON.parse(payload),
            filteredPayload = socket.filterRequestResponse(jsonPayload);


        if(sync === true)
            event.sync = sync;


        // return error, if permission not passed
        if(_.isEmpty(filteredPayload)) {
            log.trace('Not permitted to do request');

            if(event.sync)
                event.returnValue = JSON.stringify(returnError(jsonPayload, errorMethod));
            else
                event.sender.send('ipcProvider-data', JSON.stringify(returnError(jsonPayload, errorMethod)));

            return;
        }



        socket.checkRequests(filteredPayload, event, function(e, result){
            log.trace('Got result', e, result);

            if(!e && !_.isEmpty(result)) {
                log.trace('Success');

                // SEND REQUEST
                var id = result.id || result[0].id;
                
                // log.info('IPCSOCKET '+ socket.sender.getId() +' ('+ socket.id +') WRITE'+ (sync ? ' SYNC' : '') + ' ID:' + id + ' Method: '+ (result.method || result[0].method) + ' Params: '+ (result.params || result[0].params));

                // add the payload to the event, so we can time it out if necessary
                event.payload = result;
                event.eventId = id;

                if(event.sync)
                    socket.syncEvents[id] = event;
                else
                    socket.asyncEvents[id] = event;

                socket.ipcSocket.write(JSON.stringify(result));
         
            // SEND error
            } else if(e && e !== true){
                log.trace('Error');

                if(event.sync)
                    event.returnValue = JSON.stringify(returnError(jsonPayload, e));
                else
                    event.sender.send('ipcProvider-data', JSON.stringify(returnError(jsonPayload, e)));
            }
        });
    }

    ipc.on('ipcProvider-write', sendRequest);

    ipc.on('ipcProvider-writeSync', function(event, payload){
        sendRequest(event, payload, true);
    });
};


