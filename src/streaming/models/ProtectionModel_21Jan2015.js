/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * Most recent EME implementation
 *
 * Implemented by Google Chrome v36+ (Windows, OSX, Linux)
 *
 * @implements ProtectionModel
 * @class
 */
import ProtectionModel from './ProtectionModel.js';
import NeedKey from '../vo/protection/NeedKey.js';
import KeyError from '../vo/protection/KeyError.js';
import KeyMessage from '../vo/protection/KeyMessage.js';
import KeySystemConfiguration from '../vo/protection/KeySystemConfiguration.js';
import KeySystemAccess from '../vo/protection/KeySystemAccess.js';
import SessionToken from '../vo/protection/SessionToken.js';
import EventBus from '../utils/EventBus.js';
import Events from '../Events.js';

let ProtectionModel_21Jan2015 = function () {

    var videoElement = null,
        mediaKeys = null,

        // Session list
        sessions = [],

        requestKeySystemAccessInternal = function(ksConfigurations, idx) {
            var self = this;
            (function(i) {
                var keySystem = ksConfigurations[i].ks;
                var configs = ksConfigurations[i].configs;
                navigator.requestMediaKeySystemAccess(keySystem.systemString, configs).then(function(mediaKeySystemAccess) {

                    // Chrome 40 does not currently implement MediaKeySystemAccess.getConfiguration()
                    var configuration = (typeof mediaKeySystemAccess.getConfiguration === 'function') ?
                            mediaKeySystemAccess.getConfiguration() : null;
                    var keySystemAccess = new KeySystemAccess(keySystem, configuration);
                    keySystemAccess.mksa = mediaKeySystemAccess;
                    EventBus.trigger(Events.KEY_SYSTEM_ACCESS_COMPLETE, {data:keySystemAccess});

                }).catch(function() {
                    if (++i < ksConfigurations.length) {
                        requestKeySystemAccessInternal.call(self, ksConfigurations, i);
                    } else {
                        EventBus.trigger(Events.KEY_SYSTEM_ACCESS_COMPLETE, {error:"Key system access denied!"});
                    }
                });
            })(idx);
        },

        closeKeySessionInternal = function(sessionToken) {
            var session = sessionToken.session;

            // Remove event listeners
            session.removeEventListener("keystatuseschange", sessionToken);
            session.removeEventListener("message", sessionToken);

            // Send our request to the key session
            return session.close();
        },

        // This is our main event handler for all desired HTMLMediaElement events
        // related to EME.  These events are translated into our API-independent
        // versions of the same events
        createEventHandler = function() {
            var self = this;
            return {
                handleEvent: function(event) {
                    switch (event.type) {

                        case "encrypted":
                            if (event.initData) {
                                var initData = ArrayBuffer.isView(event.initData) ? event.initData.buffer : event.initData;
                                EventBus.trigger(Events.NEED_KEY, {key:new NeedKey(initData, event.initDataType)});
                            }
                            break;
                    }
                }
            };
        },
        eventHandler = null,

        removeSession = function(token) {
            // Remove from our session list
            for (var i = 0; i < sessions.length; i++) {
                if (sessions[i] === token) {
                    sessions.splice(i,1);
                    break;
                }
            }
        },

        // Function to create our session token objects which manage the EME
        // MediaKeySession and session-specific event handler
        createSessionToken = function(session, initData, sessionType) {

            var self = this;
            var token = { // Implements SessionToken
                session: session,
                initData: initData,

                // This is our main event handler for all desired MediaKeySession events
                // These events are translated into our API-independent versions of the
                // same events
                handleEvent: function(event) {
                    switch (event.type) {
                        case "keystatuseschange":
                            EventBus.trigger(Events.KEY_STATUSES_CHANGED, {data:this});
                            break;

                        case "message":
                            var message = ArrayBuffer.isView(event.message) ? event.message.buffer : event.message;
                            EventBus.trigger(Events.KEY_MESSAGE, {data:new KeyMessage(this, message, undefined, event.messageType)});
                            break;
                    }
                },

                getSessionID: function() {
                    return this.session.sessionId;
                },

                getExpirationTime: function() {
                    return this.session.expiration;
                },

                getKeyStatuses: function() {
                    return this.session.keyStatuses;
                },

                getSessionType: function() {
                    return sessionType;
                }
            };

            // Add all event listeners
            session.addEventListener("keystatuseschange", token);
            session.addEventListener("message", token);

            // Register callback for session closed Promise
            session.closed.then(function () {
                removeSession(token);
                EventBus.trigger(Events.KEY_SESSION_CLOSED, {data:token.getSessionID()});
            });

            // Add to our session list
            sessions.push(token);

            return token;
        };

    return {
        system: undefined,
        protectionExt: undefined,
        keySystem: null,

        setup: function() {
            eventHandler = createEventHandler.call(this);
        },

        /**
         * Initialize this protection model
         */
        init: function() {
        },

        teardown: function() {
            var numSessions = sessions.length,
                session,
                self = this;
            if (numSessions !== 0) {
                // Called when we are done closing a session.  Success or fail
                var done = function(session) {
                    removeSession(session);
                    if (sessions.length === 0) {
                        if (videoElement) {
                            videoElement.removeEventListener("encrypted", eventHandler);
                            videoElement.setMediaKeys(null).then(function () {
                                EventBus.trigger(Events.TEARDOWN_COMPLETE);
                            });
                        } else {
                            EventBus.trigger(Events.TEARDOWN_COMPLETE);
                        }
                    }
                };
                for (var i = 0; i < numSessions; i++) {
                    session = sessions[i];
                    (function (s) {
                        // Override closed promise resolver
                        session.session.closed.then(function () {
                            done(s);
                        });
                        // Close the session and handle errors, otherwise promise
                        // resolver above will be called
                        closeKeySessionInternal(session).catch(function () {
                            done(s);
                        });

                    })(session);
                }
            } else {
                EventBus.trigger(Events.TEARDOWN_COMPLETE);
            }
        },

        getAllInitData: function() {
            var retVal = [];
            for (var i = 0; i < sessions.length; i++) {
                retVal.push(sessions[i].initData);
            }
            return retVal;
        },

        requestKeySystemAccess: function(ksConfigurations) {
            requestKeySystemAccessInternal.call(this, ksConfigurations, 0);
        },

        selectKeySystem: function(keySystemAccess) {
            var self = this;
            keySystemAccess.mksa.createMediaKeys().then(function(mkeys) {
                self.keySystem = keySystemAccess.keySystem;
                mediaKeys = mkeys;
                if (videoElement) {
                    videoElement.setMediaKeys(mediaKeys);
                }
                EventBus.trigger(Events.KEY_SYSTEM_SELECTED);

            }).catch(function() {
                EventBus.trigger(Events.KEY_SYSTEM_SELECTED, {error:"Error selecting keys system (" + keySystemAccess.keySystem.systemString + ")! Could not create MediaKeys -- TODO"});
            });
        },

        setMediaElement: function(mediaElement) {
            if (videoElement === mediaElement)
                return;

            // Replacing the previous element
            if (videoElement) {
                videoElement.removeEventListener("encrypted", eventHandler);
                videoElement.setMediaKeys(null);
            }

            videoElement = mediaElement;

            // Only if we are not detaching from the existing element
            if (videoElement) {
                videoElement.addEventListener("encrypted", eventHandler);
                if (mediaKeys) {
                    videoElement.setMediaKeys(mediaKeys);
                }
            }
        },

        setServerCertificate: function(serverCertificate) {
            if (!this.keySystem || !mediaKeys) {
                throw new Error("Can not set server certificate until you have selected a key system");
            }
            mediaKeys.setServerCertificate(serverCertificate).then(function() {
                EventBus.trigger(Events.SERVER_CERTIFICATE_UPDATED);
            }).catch(function(error) {
                EventBus.trigger(Events.SERVER_CERTIFICATE_UPDATED, {error:"Error updating server certificate -- " + error.name});
            });
        },

        createKeySession: function(initData, sessionType) {

            if (!this.keySystem || !mediaKeys) {
                throw new Error("Can not create sessions until you have selected a key system");
            }

            var session = mediaKeys.createSession(sessionType);
            var sessionToken = createSessionToken.call(this, session, initData, sessionType);

            // Generate initial key request
            var self = this;
            session.generateRequest("cenc", initData).then(function() {
                EventBus.trigger(Events.KEY_SESSION_CREATED, {data:sessionToken});
            }).catch(function(error) {
                // TODO: Better error string
                removeSession(sessionToken);
                EventBus.trigger(Events.KEY_SESSION_CREATED, {data:null, error:"Error generating key request -- " + error.name});
            });
        },

        updateKeySession: function(sessionToken, message) {

            var session = sessionToken.session;

            // Send our request to the key session
            var self = this;
            if (this.protectionExt.isClearKey(this.keySystem)) {
                message = message.toJWK();
            }
            session.update(message).catch(function (error) {
                EventBus.trigger(Events.KEY_ERROR, {data:new KeyError(sessionToken, "Error sending update() message! " + error.name)});
            });
        },

        loadKeySession: function(sessionID) {
            if (!this.keySystem || !mediaKeys) {
                throw new Error("Can not load sessions until you have selected a key system");
            }

            var session = mediaKeys.createSession();
            // Load persisted session data into our newly created session object
            session.load(sessionID).then(function (success) {
                if (success) {
                    var sessionToken = createSessionToken.call(this, session);
                    EventBus.trigger(Events.KEY_SESSION_CREATED, {data:sessionToken});
                } else {
                    EventBus.trigger(Events.KEY_SESSION_CREATED, {data:null, error:"Could not load session! Invalid Session ID (" + sessionID + ")"});
                }
            }).catch(function (error) {
                EventBus.trigger(Events.KEY_SESSION_CREATED, {data:null, error:"Could not load session (" + sessionID + ")! " + error.name});
            });
        },

        removeKeySession: function(sessionToken) {
            var session = sessionToken.session;
            session.remove().then(function () {
                EventBus.trigger(Events.KEY_SESSION_REMOVED, {data:sessionToken.getSessionID()});
            }, function (error) {
                EventBus.trigger(Events.KEY_SESSION_REMOVED, {data:null, error:"Error removing session (" + sessionToken.getSessionID() + "). " + error.name});

            });
        },

        closeKeySession: function(sessionToken) {

            // Send our request to the key session
            var self = this;
            closeKeySessionInternal(sessionToken).catch(function(error) {
                removeSession(sessionToken);
                EventBus.trigger(Events.KEY_SESSION_CLOSED, {data:null, error:"Error closing session (" + sessionToken.getSessionID() + ") " + error.name});
            });
        }
    };
};

/**
 * Detects presence of EME v21Jan2015 APIs
 *
 * @param videoElement {HTMLMediaElement} the media element that will be
 * used for detecting API support
 * @returns {Boolean} true if support was detected, false otherwise
 */
ProtectionModel_21Jan2015.detect = function(videoElement) {
    if (videoElement.onencrypted === undefined ||
            videoElement.mediaKeys === undefined) {
        return false;
    }
    if (navigator.requestMediaKeySystemAccess === undefined ||
            typeof navigator.requestMediaKeySystemAccess !== 'function') {
        return false;
    }

    return true;
};

ProtectionModel_21Jan2015.prototype = {
    constructor: ProtectionModel_21Jan2015
};

export default ProtectionModel_21Jan2015;