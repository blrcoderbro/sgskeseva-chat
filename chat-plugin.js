/**
 * SGSK LiveChat Plugin
 * One-line install with per-application operator connection.
 */

(function() {
    'use strict';

    const defaults = {
        apiEndpoint: 'https://sgskeseva.com/api/partner',
        websocketUrl: null,
        apiKey: null,
        applicationId: null,
        userMobile: null,
        userName: 'Website Visitor',
        theme: 'light',
        title: 'Application Support',
        subtitle: 'We reply within minutes',
        position: 'bottom-right',
        autoLaunch: true,
        autoLaunchDelay: 800,
        soundEnabled: true,
        primaryColor: '#2563eb',
        secondaryColor: '#1d4ed8',
        companyName: 'Support',
        statusPollInterval: 10000
    };

    let config = null;
    let socket = null;
    let initialized = false;
    let widget = null;
    let chatWindow = null;
    let messagesEl = null;
    let inputEl = null;
    let formEl = null;
    let statusEl = null;
    let badgeEl = null;
    let typingEl = null;
    let sessionToken = null;
    let unreadCount = 0;
    let isAuthenticated = false;
    let operatorAccepted = false;
    let statusPollTimer = null;
    let currentSocketUrl = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;

    function getScriptTag() {
        return document.currentScript || document.querySelector('script[src*="chat.js"]');
    }

    function readDataConfig() {
        const script = getScriptTag();
        if (!script) return {};

        return {
            apiEndpoint: script.getAttribute('data-api-endpoint'),
            websocketUrl: script.getAttribute('data-websocket-url'),
            apiKey: script.getAttribute('data-api-key'),
            applicationId: script.getAttribute('data-application-id'),
            userMobile: script.getAttribute('data-user-mobile'),
            userName: script.getAttribute('data-user-name'),
            theme: script.getAttribute('data-theme'),
            title: script.getAttribute('data-title'),
            subtitle: script.getAttribute('data-subtitle'),
            position: script.getAttribute('data-position'),
            primaryColor: script.getAttribute('data-primary-color'),
            secondaryColor: script.getAttribute('data-secondary-color'),
            companyName: script.getAttribute('data-company-name'),
            autoLaunch: script.getAttribute('data-auto-launch'),
            soundEnabled: script.getAttribute('data-sound-enabled')
        };
    }

    function normalizeConfig(input) {
        const merged = Object.assign({}, defaults, window.SGSKChatConfig || {}, readDataConfig(), input || {});

        merged.applicationId = merged.applicationId ? String(merged.applicationId) : null;
        merged.userMobile = merged.userMobile ? String(merged.userMobile).trim() : null;
        merged.apiKey = merged.apiKey ? String(merged.apiKey).trim() : null;
        merged.autoLaunch = merged.autoLaunch !== false && merged.autoLaunch !== 'false';
        merged.soundEnabled = merged.soundEnabled !== false && merged.soundEnabled !== 'false';

        return merged;
    }

    function ensureRequiredConfig() {
        const missing = [];
        if (!config.apiKey) missing.push('apiKey');
        if (!config.applicationId) missing.push('applicationId');
        if (!config.userMobile) missing.push('userMobile');
        if (missing.length) {
            throw new Error('Missing required chat config: ' + missing.join(', '));
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }

    function createWidget() {
        if (widget) widget.remove();

        const isLeft = config.position === 'bottom-left';
        widget = document.createElement('div');
        widget.id = 'sgsk-chat-widget';
        widget.innerHTML = `
            <div id="sgsk-chat-button" style="position:fixed;bottom:20px;${isLeft ? 'left' : 'right'}:20px;z-index:999999;cursor:pointer;">
                <div style="width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,${config.primaryColor},${config.secondaryColor});box-shadow:0 8px 24px rgba(0,0,0,.18);">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                </div>
                <div id="sgsk-unread-badge" style="display:none;position:absolute;top:-6px;${isLeft ? 'right' : 'left'}:-6px;min-width:22px;height:22px;padding:0 6px;border-radius:999px;background:#ef4444;color:#fff;font:700 12px/22px Arial,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.18);">0</div>
            </div>
            <div id="sgsk-chat-window" style="display:none;position:fixed;bottom:92px;${isLeft ? 'left' : 'right'}:20px;width:360px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 112px);background:#fff;border-radius:16px;box-shadow:0 18px 48px rgba(0,0,0,.22);z-index:999999;overflow:hidden;flex-direction:column;font-family:Arial,sans-serif;">
                <div style="padding:16px;background:linear-gradient(135deg,${config.primaryColor},${config.secondaryColor});color:#fff;display:flex;align-items:center;justify-content:space-between;gap:10px;">
                    <div>
                        <div style="font-size:16px;font-weight:700;">${escapeHtml(config.title || config.companyName)}</div>
                        <div style="font-size:12px;opacity:.9;">${escapeHtml(config.subtitle)}</div>
                    </div>
                    <button id="sgsk-close-chat" type="button" style="background:none;border:none;color:#fff;font-size:24px;cursor:pointer;line-height:1;">&times;</button>
                </div>
                <div id="sgsk-chat-status" style="padding:10px 14px;background:#eff6ff;color:#1d4ed8;font-size:12px;border-bottom:1px solid #dbeafe;">Ready to connect</div>
                <div id="sgsk-chat-messages" style="flex:1;overflow-y:auto;padding:16px;background:#f8fafc;">
                    <div style="text-align:center;margin:8px 0 18px;">
                        <div style="display:inline-block;background:#fff;border-radius:12px;padding:12px 14px;color:#334155;box-shadow:0 2px 10px rgba(0,0,0,.06);">${escapeHtml(config.theme === 'light' ? 'Open chat to connect to your application operator.' : 'Open chat to connect to your application operator.')}</div>
                    </div>
                    <div id="sgsk-typing-indicator" style="display:none;margin:8px 0 0 0;">
                        <div style="display:inline-block;background:#fff;border-radius:14px;padding:10px 12px;box-shadow:0 2px 10px rgba(0,0,0,.06);color:#64748b;font-size:12px;">Operator is typing...</div>
                    </div>
                </div>
                <div style="padding:14px;border-top:1px solid #e2e8f0;background:#fff;">
                    <form id="sgsk-chat-form" style="display:flex;gap:8px;align-items:center;">
                        <input id="sgsk-chat-input" type="text" placeholder="Waiting for operator..." disabled style="flex:1;padding:11px 14px;border:1px solid #cbd5e1;border-radius:999px;outline:none;font-size:14px;background:#f8fafc;" />
                        <button id="sgsk-chat-send" type="submit" disabled style="border:none;background:${config.primaryColor};color:#fff;border-radius:999px;padding:11px 16px;cursor:pointer;opacity:.55;">
                            Send
                        </button>
                    </form>
                </div>
            </div>
            <style>
                #sgsk-chat-button:hover { transform: scale(1.04); transition: transform .18s ease; }
                #sgsk-chat-messages::-webkit-scrollbar { width: 6px; }
                #sgsk-chat-messages::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 999px; }
            </style>
        `;

        document.body.appendChild(widget);
        chatWindow = document.getElementById('sgsk-chat-window');
        messagesEl = document.getElementById('sgsk-chat-messages');
        inputEl = document.getElementById('sgsk-chat-input');
        formEl = document.getElementById('sgsk-chat-form');
        statusEl = document.getElementById('sgsk-chat-status');
        badgeEl = document.getElementById('sgsk-unread-badge');
        typingEl = document.getElementById('sgsk-typing-indicator');

        document.getElementById('sgsk-chat-button').addEventListener('click', toggle);
        document.getElementById('sgsk-close-chat').addEventListener('click', close);
        formEl.addEventListener('submit', sendMessage);
    }

    function appendSystemMessage(text) {
        const el = document.createElement('div');
        el.style.cssText = 'margin:10px 0;text-align:center;font-size:12px;color:#64748b;';
        el.textContent = text;
        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendMessage(text, type) {
        const row = document.createElement('div');
        row.style.cssText = 'margin:10px 0;text-align:' + (type === 'sent' ? 'right' : 'left') + ';';
        row.innerHTML = '<span style="display:inline-block;max-width:82%;padding:10px 14px;border-radius:16px;box-shadow:0 2px 10px rgba(0,0,0,.06);background:' + (type === 'sent' ? config.primaryColor : '#fff') + ';color:' + (type === 'sent' ? '#fff' : '#0f172a') + ';word-break:break-word;">' + escapeHtml(text) + '</span>';
        messagesEl.insertBefore(row, typingEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function setStatus(text, tone) {
        if (!statusEl) return;
        const tones = {
            info: { bg: '#eff6ff', color: '#1d4ed8', border: '#dbeafe' },
            waiting: { bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
            success: { bg: '#ecfdf5', color: '#047857', border: '#a7f3d0' },
            error: { bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' }
        };
        const palette = tones[tone] || tones.info;
        statusEl.textContent = text;
        statusEl.style.background = palette.bg;
        statusEl.style.color = palette.color;
        statusEl.style.borderBottom = '1px solid ' + palette.border;
    }

    function setInputEnabled(enabled) {
        if (!inputEl) return;
        const sendButton = document.getElementById('sgsk-chat-send');
        inputEl.disabled = !enabled;
        sendButton.disabled = !enabled;
        sendButton.style.opacity = enabled ? '1' : '.55';
        inputEl.placeholder = enabled ? 'Type a message...' : 'Waiting for operator...';
        inputEl.style.background = enabled ? '#fff' : '#f8fafc';
    }

    function incrementUnread() {
        unreadCount += 1;
        badgeEl.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        badgeEl.style.display = 'block';
    }

    function resetUnread() {
        unreadCount = 0;
        if (badgeEl) {
            badgeEl.textContent = '0';
            badgeEl.style.display = 'none';
        }
    }

    function open() {
        chatWindow.style.display = 'flex';
        resetUnread();
        if (!socket) {
            connect();
        }
    }

    function close() {
        if (chatWindow) chatWindow.style.display = 'none';
    }

    function toggle() {
        const hidden = chatWindow.style.display === 'none' || chatWindow.style.display === '';
        if (hidden) open();
        else close();
    }

    function playNotificationSound() {
        if (!config.soundEnabled) return;
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            oscillator.frequency.value = 820;
            gainNode.gain.setValueAtTime(0.18, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.14);
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.14);
        } catch (e) {}
    }

    function fetchChatToken() {
        return fetch(config.apiEndpoint.replace(/\/$/, '') + '/generate_chat_token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': config.apiKey
            },
            body: JSON.stringify({
                application_id: Number(config.applicationId),
                user_mobile: config.userMobile
            })
        }).then(async function(res) {
            const data = await res.json().catch(function() { return {}; });
            if (!res.ok || !data.success || !data.data || !data.data.token) {
                throw new Error(data.message || 'Failed to generate chat token');
            }
            return data.data;
        });
    }

    function syncApplicationStatus() {
        return fetch(config.apiEndpoint.replace(/\/$/, '') + '/application_status?application_id=' + encodeURIComponent(config.applicationId), {
            method: 'GET',
            headers: {
                'X-API-Key': config.apiKey
            }
        }).then(async function(res) {
            const data = await res.json().catch(function() { return {}; });
            if (!res.ok || !data.success || !data.data) {
                throw new Error(data.message || 'Failed to fetch application status');
            }
            return data.data;
        });
    }

    function applyApplicationStatus(statusData) {
        const accepted = statusData.status === 'accepted' || !!statusData.assigned_operator_id || !!statusData.chat_active;
        if (accepted) {
            if (!operatorAccepted) {
                appendSystemMessage('Operator joined your application chat. You can start messaging now.');
            }
            operatorAccepted = true;
            setInputEnabled(true);
            setStatus('Operator is online and connected to this application', 'success');
            stopStatusPolling();
        } else {
            operatorAccepted = false;
            setInputEnabled(false);
            setStatus('Finding operator, please wait. Operator status is online, waiting for acceptance of request.', 'waiting');
            startStatusPolling();
        }
    }

    function startStatusPolling() {
        if (statusPollTimer) return;
        statusPollTimer = window.setInterval(function() {
            syncApplicationStatus().then(applyApplicationStatus).catch(function() {});
        }, config.statusPollInterval);
    }

    function stopStatusPolling() {
        if (statusPollTimer) {
            clearInterval(statusPollTimer);
            statusPollTimer = null;
        }
    }

    function clearReconnectTimer() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }

    function resetConnectionState() {
        isAuthenticated = false;
        operatorAccepted = false;
        setInputEnabled(false);
    }

    function cleanupSocket() {
        if (!socket) return;
        try {
            socket.removeAllListeners();
            socket.disconnect();
        } catch (e) {
        }
        socket = null;
    }

    function scheduleReconnect(reason) {
        if (!initialized || reconnectTimer) return;
        reconnectAttempt += 1;
        const delay = Math.min(15000, Math.max(1000, reconnectAttempt * 1500));
        setStatus('Reconnecting to this application chat...', 'error');
        appendSystemMessage((reason || 'Connection lost') + ' Retrying in ' + Math.round(delay / 1000) + 's...');
        reconnectTimer = window.setTimeout(function() {
            reconnectTimer = null;
            cleanupSocket();
            connect(true);
        }, delay);
    }

    function bindSocketEvents() {
        socket.on('connect', function() {
            setStatus('Connecting to your application chat...', 'info');
            socket.emit('authenticate', { token: sessionToken });
        });

        socket.on('authenticated', function() {
            isAuthenticated = true;
            reconnectAttempt = 0;
            clearReconnectTimer();
            setStatus('Connected to chat service. Checking operator status...', 'info');
            syncApplicationStatus().then(applyApplicationStatus).catch(function(error) {
                setStatus(error.message || 'Connected, but failed to fetch application status', 'error');
            });
        });

        socket.on('auth_error', function(payload) {
            resetConnectionState();
            startStatusPolling();
            scheduleReconnect((payload && payload.message) || 'Authentication expired.');
        });

        socket.on('request_accepted', function(evt) {
            if (!evt) return;
            if (String(evt.application_id || evt.id || '') !== String(config.applicationId)) return;
            operatorAccepted = true;
            setInputEnabled(true);
            setStatus('Operator accepted your request. Real-time chat is now active.', 'success');
            appendSystemMessage((evt.operator_name || 'An operator') + ' accepted your request.');
            stopStatusPolling();
        });

        socket.on('new_message', function(msg) {
            if (!msg) return;
            if (String(msg.source_id || '') !== String(config.applicationId)) return;
            if (msg.sender_type === 'end_user') return;
            appendMessage(msg.message || msg.content || '', 'received');
            if (config.autoLaunch && (chatWindow.style.display === 'none' || chatWindow.style.display === '')) {
                setTimeout(function() {
                    open();
                }, config.autoLaunchDelay);
            }
            if (chatWindow.style.display === 'none' || chatWindow.style.display === '') {
                incrementUnread();
            }
            playNotificationSound();
        });

        socket.on('user_typing', function(payload) {
            if (payload && payload.userType === 'operator') {
                typingEl.style.display = 'block';
                messagesEl.scrollTop = messagesEl.scrollHeight;
            }
        });

        socket.on('user_stop_typing', function() {
            typingEl.style.display = 'none';
        });

        socket.on('connect_error', function(err) {
            resetConnectionState();
            setStatus('Connection lost. Reconnecting to your application chat...', 'error');
            scheduleReconnect((err && err.message) ? err.message : 'Connection lost.');
        });

        socket.on('disconnect', function() {
            resetConnectionState();
            setStatus('Disconnected. Attempting to reconnect...', 'error');
            startStatusPolling();
            scheduleReconnect('Disconnected from chat service.');
        });
    }

    function connect(forceRefresh) {
        if (socket && !forceRefresh) return;
        cleanupSocket();
        clearReconnectTimer();

        setStatus('Preparing secure connection for this application...', 'info');
        appendSystemMessage('Opening secure chat for application #' + config.applicationId + '...');

        fetchChatToken().then(function(tokenData) {
            sessionToken = tokenData.token;
            currentSocketUrl = tokenData.websocket_url || config.websocketUrl || defaults.websocketUrl || 'wss://chat.sgskeseva.com';
            socket = window.io(currentSocketUrl, {
                transports: ['websocket', 'polling'],
                reconnection: true,
                reconnectionAttempts: 10,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 15000
            });
            bindSocketEvents();
        }).catch(function(error) {
            resetConnectionState();
            setStatus('Unable to initialize chat', 'error');
            appendSystemMessage(error.message || 'Unable to initialize chat');
            scheduleReconnect(error.message || 'Unable to initialize chat.');
        });
    }

    function sendMessage(event) {
        event.preventDefault();
        const message = inputEl.value.trim();
        if (!message || !socket || !isAuthenticated || !operatorAccepted) return;

        socket.emit('send_message', { message: message, message_type: 'text' }, function(response) {
            if (!response || response.success === false) {
                appendSystemMessage((response && response.message) || 'Failed to send message');
                return;
            }
            appendMessage(message, 'sent');
            inputEl.value = '';
        });
    }

    function destroy() {
        clearReconnectTimer();
        stopStatusPolling();
        cleanupSocket();
        if (widget) {
            widget.remove();
            widget = null;
        }
        chatWindow = null;
        messagesEl = null;
        inputEl = null;
        formEl = null;
        statusEl = null;
        badgeEl = null;
        typingEl = null;
        initialized = false;
        isAuthenticated = false;
        operatorAccepted = false;
        unreadCount = 0;
        sessionToken = null;
        currentSocketUrl = null;
        reconnectAttempt = 0;
    }

    function init(options) {
        const nextConfig = normalizeConfig(options);
        config = nextConfig;
        ensureRequiredConfig();
        destroy();
        config = nextConfig;
        createWidget();
        setInputEnabled(false);
        setStatus('Ready to connect to this application', 'info');
        initialized = true;
        return window.ChatWidget;
    }

    function autoInitIfConfigured() {
        const merged = normalizeConfig();
        if (!merged.apiKey || !merged.applicationId || !merged.userMobile) {
            return;
        }

        try {
            init(merged);
        } catch (error) {
            console.warn('SGSK Chat auto-init failed:', error.message);
        }
    }

    function loadSocketIo(callback) {
        if (window.io) {
            callback();
            return;
        }

        const script = document.createElement('script');
        script.src = 'https://cdn.socket.io/4.6.1/socket.io.min.js';
        script.async = true;
        script.onload = callback;
        script.onerror = function() {
            console.error('SGSK Chat: failed to load Socket.IO');
        };
        document.head.appendChild(script);
    }

    window.ChatWidget = {
        init: init,
        open: open,
        close: close,
        destroy: destroy,
        sendMessage: function(message) {
            if (!message || !socket || !isAuthenticated || !operatorAccepted) {
                return false;
            }
            socket.emit('send_message', { message: String(message), message_type: 'text' }, function(response) {
                if (!response || response.success === false) {
                    appendSystemMessage((response && response.message) || 'Failed to send message');
                    return;
                }
                appendMessage(String(message), 'sent');
            });
            return true;
        },
        setUserData: function(data) {
            const nextConfig = normalizeConfig(Object.assign({}, config || {}, data || {}));
            const mustReconnect = !config
                || String(config.applicationId || '') !== String(nextConfig.applicationId || '')
                || String(config.userMobile || '') !== String(nextConfig.userMobile || '')
                || String(config.apiKey || '') !== String(nextConfig.apiKey || '');

            config = nextConfig;

            if (mustReconnect && initialized) {
                init(config);
            }
        },
        trackEvent: function(name, data) {
            if (!name) return false;
            if (window.console && console.debug) {
                console.debug('SGSKChat event', { name: name, data: data || null, applicationId: config && config.applicationId ? config.applicationId : null });
            }
            return true;
        },
        getState: function() {
            return {
                initialized: initialized,
                isAuthenticated: isAuthenticated,
                operatorAccepted: operatorAccepted,
                applicationId: config && config.applicationId ? config.applicationId : null,
                websocketUrl: currentSocketUrl
            };
        }
    };

    window.SGSKChat = window.ChatWidget;

    window.addEventListener('beforeunload', function() {
        clearReconnectTimer();
        stopStatusPolling();
        cleanupSocket();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            loadSocketIo(autoInitIfConfigured);
        });
    } else {
        loadSocketIo(autoInitIfConfigured);
    }
})();
