/* vim: ts=4:sw=4:expandtab
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

;(function() {
    'use strict';
    if (!localStorage.getItem('first_install_ran')) {
        localStorage.setItem('first_install_ran', 1);
        extension.navigator.tabs.create("options.html");
    }

    var conversations = new Whisper.ConversationCollection();
    var messages      = new Whisper.MessageCollection();

    function onMessageReceived(pushMessage) {
        var now = new Date().getTime();
        var timestamp = pushMessage.timestamp.toNumber()

        var conversation = conversations.add({
            id   : pushMessage.source,
            type : 'private'
        }, { merge : true } );

        var message = messages.add({
            id             : [pushMessage.source, timestamp],
            source         : pushMessage.source,
            sourceDevice   : pushMessage.sourceDevice,
            relay          : pushMessage.relay,
            sent_at        : timestamp,
            received_at    : now,
            conversationId : conversation.id,
            type           : 'incoming'
        });

        var newUnreadCount = textsecure.storage.getUnencrypted("unreadCount", 0) + 1;
        textsecure.storage.putUnencrypted("unreadCount", newUnreadCount);
        extension.navigator.setBadgeText(newUnreadCount);

        conversation.save().then(function() {
            message.save().then(function() {
                decryptMessage(pushMessage);
            });
        });
    };

    function decryptMessage(proto) {
        // This event can be triggered from the background script on an
        // incoming message or from the frontend after the user accepts an
        // identity key change.
        return new Promise(function(resolve) {
            resolve(textsecure.protocol.handleIncomingPushMessageProto(proto));
        }).then(textsecure.handleDecrypted).then(function(decrypted) {
            var now = new Date().getTime();
            var attributes = {};
            if (decrypted.group) {
                attributes = {
                    id         : decrypted.group.id,
                    groupId    : decrypted.group.id,
                    name       : decrypted.group.name || 'New group',
                    type       : 'group',
                };
            } else {
                attributes = {
                    id         : proto.source,
                    name       : proto.source,
                    type       : 'private'
                };
            }
            var conversation = conversations.add(attributes, {merge: true});
            conversation.set({ active_at: now });

            var message = messages.add({
                id             : [proto.source, timestamp],
                body           : decrypted.body,
                conversationId : conversation.id,
                attachments    : decrypted.attachments,
                type           : 'incoming',
                source         : proto.source,
                decrypted_at   : now
            }, { merge : true } );

            conversation.save().then(function() {
                message.save().then(function() {
                    extension.trigger('message', message); // notify frontend listeners
                });
            });
        }).catch(function(e) {
            if (e.name === 'IncomingIdentityKeyError') {
                var message = messages.add({
                    id     : [pushMessage.source, pushMessage.timestamp],
                    errors : [e]
                }, {merge: true}).save().then(function() {
                    extension.trigger('message', message); // notify frontend listeners
                });
            } else {
                throw e;
            }
        });
    }

    function onDeliveryReceipt(pushMessage) {
        var timestamp = pushMessage.timestamp.toNumber();
        var messages = new Whisper.MessageCollection();
        console.log('delivery receipt', pushMessage.source, timestamp);
        messages.fetch({
            index: {
                // 'receipt' index on sent_at
                name: 'receipt',
                lower: timestamp,
                upper: timestamp
            }
        }).then(function() {
            messages = messages.where({type: 'outgoing'});
            var groups = new Whisper.ConversationCollection();
            groups.fetch({ name: 'group', only: pushMessage.source }).then(function() {
                var groupIds = groups.pluck('id');
                for (var message in messages) {
                    var deliveries     = message.get('delivered') || 0;
                    var conversationId = message.get('conversationId');
                    if (conversationId === pushMessage.source ||
                        _.contains(groupIds, conversationId)) {
                        message.save({delivered: deliveries + 1});
                        return;
                        // TODO: consider keeping a list of numbers we've
                        // successfully delivered to?
                    }
                }
            });
        }).fail(function() {
            console.log('got delivery receipt for unknown message', pushMessage.source, timestamp);
        });
    };

    if (textsecure.registration.isDone()) {
        init();
    } else {
        extension.on('registration_done', init);
    }

    function init() {
        if (!textsecure.registration.isDone()) { return; }

        // initialize the socket and start listening for messages
        var socket = textsecure.api.getMessageWebsocket();
        new WebSocketResource(socket, function(request) {
            // TODO: handle different types of requests. for now we only expect
            // PUT /messages <encrypted IncomingPushMessageSignal>
            textsecure.protocol.decryptWebsocketMessage(request.body).then(function(plaintext) {
                var proto = textsecure.protobuf.IncomingPushMessageSignal.decode(plaintext);
                // After this point, decoding errors are not the server's
                // fault, and we should handle them gracefully and tell the
                // user they received an invalid message
                request.respond(200, 'OK');

                if (proto.type === textsecure.protobuf.IncomingPushMessageSignal.Type.RECEIPT) {
                    onDeliveryReceipt(proto);
                } else {
                    onMessageReceived(proto);
                }

            }).catch(function(e) {
                console.log("Error handling incoming message:", e);
                extension.trigger('error', e);
                request.respond(500, 'Bad encrypted websocket message');
            });
        });
    };
})();
