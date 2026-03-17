/**
 * Chat Widget Plugin v2.0
 *
 * Embeddable chat widget for API partner websites.
 * Provides real-time chat between end users and platform operators.
 *
 * Improvements over v1:
 *  - Unread message badge on toggle button
 *  - Message delivery status ticks (sent / delivered)
 *  - Date-group separators between messages
 *  - Empty-state illustration
 *  - Sound toggle (plays a subtle beep on incoming messages)
 *  - Smooth open/close animation (scale + fade)
 *  - Auto-reconnect with exponential back-off
 *  - Configurable theme colours via CSS variables
 *  - Accessibility: roles, aria-labels, focus management
 *  - Mobile-responsive (full-screen on small viewports)
 *  - No global function pollution – all callbacks wired in JS
 *  - XSS-safe, linkifies http URLs in messages
 *  - Configurable position (bottom-right / bottom-left)
 *  - destroyChatWidget() helper for SPA teardown
 */
(function (window) {
    'use strict';

    /* ─────────────────────────────────────────────────────────────
       CONSTANTS
    ───────────────────────────────────────────────────────────── */
    const RECONNECT_BASE_DELAY   = 1000;   // ms
    const RECONNECT_MAX_DELAY    = 30000;  // ms
    const TYPING_DEBOUNCE        = 1500;   // ms

    /* ─────────────────────────────────────────────────────────────
       THEME PALETTES  (extend freely)
    ───────────────────────────────────────────────────────────── */
    const THEMES = {
        blue:   { primary: '#4361ee', secondary: '#3a0ca3', accent: '#4cc9f0' },
        green:  { primary: '#2d6a4f', secondary: '#1b4332', accent: '#74c69d' },
        orange: { primary: '#e76f51', secondary: '#c1440e', accent: '#ffd166' },
        purple: { primary: '#7b2d8b', secondary: '#4a0e8f', accent: '#c77dff' },
        dark:   { primary: '#1a1a2e', secondary: '#16213e', accent: '#e94560'  },
        rose:   { primary: '#c9184a', secondary: '#800f2f', accent: '#ffb3c6' },
    };

    /* ─────────────────────────────────────────────────────────────
       TINY BEEP via Web Audio API
    ───────────────────────────────────────────────────────────── */
    function playBeep() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.3);
        } catch (_) { /* silently skip if AudioContext unavailable */ }
    }

    /* ─────────────────────────────────────────────────────────────
       HELPERS
    ───────────────────────────────────────────────────────────── */
    function escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }

    function linkify(html) {
        return html.replace(
            /(https?:\/\/[^\s<>"']+)/g,
            '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">$1</a>'
        );
    }

    function formatTime(dateStr) {
        return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatDateLabel(dateStr) {
        const d = new Date(dateStr);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        if (d.toDateString() === today.toDateString())     return 'Today';
        if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    }

    function dateKey(dateStr) {
        return new Date(dateStr).toDateString();
    }

    /* ─────────────────────────────────────────────────────────────
       MAIN WIDGET OBJECT
    ───────────────────────────────────────────────────────────── */
    const ChatWidget = {
        config: {},
        socket: null,
        isConnected: false,
        isOpen: false,
        isTyping: false,
        soundEnabled: true,
        typingTimeout: null,
        reconnectDelay: RECONNECT_BASE_DELAY,
        reconnectTimer: null,
        unreadCount: 0,
        lastDateLabel: null,          // tracks current date group
        _pendingMsgId: null,          // id of last "sent" bubble awaiting ack
        cachedToken: null,            // cached JWT so reconnects don't re-hit generate_chat_token
        cachedTokenExpiry: 0,         // token expiry as Unix seconds
        reconnectAttempts: 0,         // times we've tried to reconnect since last success
        maxReconnectAttempts: 10,     // give up after this many consecutive failures

        /* ── init ───────────────────────────────────────────── */
        init: function (options) {
            this.config = {
                apiEndpoint:   options.apiEndpoint,
                websocketUrl:  options.websocketUrl || '',
                applicationId: options.applicationId,
                userMobile:    options.userMobile,
                apiKey:        options.apiKey || '',
                theme:         options.theme  || 'blue',
                title:         options.title  || 'Support Chat',
                subtitle:      options.subtitle || 'We reply within minutes',
                position:      options.position || 'bottom-right',
                soundEnabled:  options.soundEnabled !== false,
            };

            const missing = [];
            if (!this.config.apiEndpoint)   missing.push('apiEndpoint');
            if (!this.config.applicationId) missing.push('applicationId');
            if (!this.config.userMobile)    missing.push('userMobile');
            if (!this.config.apiKey)        missing.push('apiKey');
            if (missing.length) {
                console.error('ChatWidget: missing required options:', missing.join(', '));
                return;
            }

            this.soundEnabled = this.config.soundEnabled;
            this.createWidget();
            this.authenticateAndConnect();
        },

        /* ── createWidget ───────────────────────────────────── */
        createWidget: function () {
            const isLeft = this.config.position === 'bottom-left';
            const posStyle = isLeft
                ? 'left:20px;right:auto;'
                : 'right:20px;left:auto;';

            // ── Main container ──
            const container = document.createElement('div');
            container.id = 'cwg-container';
            container.setAttribute('role', 'dialog');
            container.setAttribute('aria-label', this.config.title);
            container.setAttribute('aria-hidden', 'true');
            container.innerHTML = `
                <!-- HEADER -->
                <div class="cwg-header">
                    <div class="cwg-header-avatar" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15H9V8h2v9zm4 0h-2V8h2v9z"/>
                        </svg>
                    </div>
                    <div class="cwg-header-info">
                        <div class="cwg-header-title">${escapeHtml(this.config.title)}</div>
                        <div class="cwg-header-subtitle">${escapeHtml(this.config.subtitle)}</div>
                    </div>
                    <div class="cwg-header-actions">
                        <button class="cwg-icon-btn" id="cwg-sound-btn" aria-label="Toggle sound" title="Toggle sound">
                            <svg id="cwg-sound-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                            </svg>
                            <svg id="cwg-sound-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none">
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                                <line x1="23" y1="9" x2="17" y2="15"></line>
                                <line x1="17" y1="9" x2="23" y2="15"></line>
                            </svg>
                        </button>
                        <button class="cwg-icon-btn" id="cwg-close-btn" aria-label="Close chat">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                </div>

                <!-- STATUS BAR -->
                <div class="cwg-status" id="cwg-status" role="status" aria-live="polite">
                    <span class="cwg-status-dot"></span>
                    <span class="cwg-status-text">Connecting…</span>
                </div>

                <!-- MESSAGES -->
                <div class="cwg-messages" id="cwg-messages" role="log" aria-live="polite" aria-label="Chat messages">
                    <div class="cwg-empty-state" id="cwg-empty">
                        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="4" y="10" width="56" height="38" rx="8" fill="var(--cwg-primary)" opacity=".12"/>
                            <rect x="8" y="14" width="48" height="30" rx="6" fill="var(--cwg-primary)" opacity=".2"/>
                            <path d="M16 26h32M16 33h20" stroke="var(--cwg-primary)" stroke-width="2.5" stroke-linecap="round"/>
                            <path d="M24 48l-6 8 14-8" fill="var(--cwg-primary)" opacity=".3"/>
                        </svg>
                        <p>No messages yet</p>
                        <span>Send a message to start the conversation!</span>
                    </div>
                </div>

                <!-- TYPING INDICATOR (lives outside messages scroll) -->
                <div class="cwg-typing-wrap" id="cwg-typing-wrap" aria-hidden="true" style="display:none">
                    <div class="cwg-typing">
                        <span></span><span></span><span></span>
                    </div>
                    <div class="cwg-typing-label">Typing…</div>
                </div>

                <!-- INPUT -->
                <div class="cwg-input-row">
                    <input
                        type="text"
                        id="cwg-input"
                        placeholder="Type a message…"
                        autocomplete="off"
                        aria-label="Message input"
                        maxlength="2000"
                    />
                    <button id="cwg-send-btn" aria-label="Send message" disabled>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                    </button>
                </div>
            `;
            container.style.cssText = `${posStyle}`;
            document.body.appendChild(container);

            // ── Toggle Button ──
            const toggleBtn = document.createElement('button');
            toggleBtn.id = 'cwg-toggle';
            toggleBtn.setAttribute('aria-label', 'Open chat');
            toggleBtn.style.cssText = posStyle;
            toggleBtn.innerHTML = `
                <svg id="cwg-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <span id="cwg-badge" class="cwg-badge" style="display:none">0</span>
            `;
            document.body.appendChild(toggleBtn);

            this.addStyles();
            this.bindEvents();
        },

        /* ── bindEvents ─────────────────────────────────────── */
        bindEvents: function () {
            document.getElementById('cwg-toggle').addEventListener('click',    () => this.open());
            document.getElementById('cwg-close-btn').addEventListener('click', () => this.close());
            document.getElementById('cwg-sound-btn').addEventListener('click', () => this.toggleSound());

            const input   = document.getElementById('cwg-input');
            const sendBtn = document.getElementById('cwg-send-btn');

            input.addEventListener('input', () => {
                sendBtn.disabled = !input.value.trim();
                this.handleTyping();
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });
            sendBtn.addEventListener('click', () => this.sendMessage());
        },

        /* ── open / close / toggle ──────────────────────────── */
        open: function () {
            if (this.isOpen) return;
            this.isOpen = true;
            const container = document.getElementById('cwg-container');
            const toggleBtn = document.getElementById('cwg-toggle');
            container.classList.add('cwg-open');
            container.setAttribute('aria-hidden', 'false');
            toggleBtn.style.display = 'none';
            this.clearUnread();
            // Focus input after animation
            setTimeout(() => {
                const inp = document.getElementById('cwg-input');
                if (inp) inp.focus();
            }, 320);
        },

        close: function () {
            if (!this.isOpen) return;
            this.isOpen = false;
            const container = document.getElementById('cwg-container');
            const toggleBtn = document.getElementById('cwg-toggle');
            container.classList.remove('cwg-open');
            container.setAttribute('aria-hidden', 'true');
            toggleBtn.style.display = 'flex';
        },

        /* ── sound toggle ───────────────────────────────────── */
        toggleSound: function () {
            this.soundEnabled = !this.soundEnabled;
            document.getElementById('cwg-sound-on').style.display  = this.soundEnabled ? ''     : 'none';
            document.getElementById('cwg-sound-off').style.display = this.soundEnabled ? 'none' : '';
        },

        /* ── unread badge ───────────────────────────────────── */
        incrementUnread: function () {
            if (this.isOpen) return;
            this.unreadCount++;
            const badge = document.getElementById('cwg-badge');
            badge.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
            badge.style.display = 'flex';
        },

        clearUnread: function () {
            this.unreadCount = 0;
            const badge = document.getElementById('cwg-badge');
            if (badge) { badge.style.display = 'none'; badge.textContent = '0'; }
        },

        /* ── authenticate + connect ─────────────────────────── */
        authenticateAndConnect: async function () {
            try {
                const nowSec = Date.now() / 1000;
                const tokenStillValid = this.cachedToken && this.cachedTokenExpiry > nowSec + 60;

                if (!tokenStillValid) {
                    const { token, websocketUrl, expiresIn } = await this.fetchChatToken();
                    this.cachedToken = token;
                    this.cachedTokenExpiry = nowSec + (expiresIn || 86400);
                    if (websocketUrl) this.config.websocketUrl = websocketUrl;
                }

                if (this.cachedToken && this.config.websocketUrl) {
                    this.connect(this.cachedToken);
                } else if (this.cachedToken && !this.config.websocketUrl) {
                    this.updateStatus('No WebSocket URL configured', false);
                } else {
                    this.updateStatus('Could not get token', false);
                }
            } catch (err) {
                console.error('ChatWidget: Auth failed', err);
                this.updateStatus(err.message || 'Authentication failed', false);
                // Permanent errors (application not found, access denied) — no point retrying
                if (!err.permanent) {
                    this.scheduleReconnect();
                }
            }
        },

        fetchChatToken: async function () {
            const response = await fetch(`${this.config.apiEndpoint}/generate_chat_token`, {
                method: 'POST',
                mode: 'cors',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.config.apiKey
                },
                body: JSON.stringify({
                    application_id: this.config.applicationId,
                    user_mobile:    this.config.userMobile
                })
            });

            // Surface friendly errors for common failure codes
            if (!response.ok) {
                const statusMessages = {
                    401: 'Invalid API key',
                    403: 'Access denied – check application ID or mobile number',
                    404: 'Application not found',
                    429: 'Rate limit reached – please wait before retrying',
                    500: 'Server error – contact support'
                };
                const msg = statusMessages[response.status] || `Request failed (${response.status})`;
                const fetchErr = new Error(msg);
                fetchErr.statusCode = response.status;
                // 404 = application not found, 403 = access denied — retrying will never help
                fetchErr.permanent = (response.status === 404 || response.status === 403);
                throw fetchErr;
            }

            const ct   = response.headers.get('Content-Type') || '';
            const text = await response.text();
            const result = ct.includes('application/json')
                ? JSON.parse(text)
                : { success: false, message: 'Invalid server response' };

            if (!result.success) throw new Error(result.message || result.error || 'Token request failed');
            return {
                token:        result.data?.token || null,
                websocketUrl: result.data?.websocket_url || null,
                expiresIn:    result.data?.expires_in   || 86400
            };
        },

        /* ── WebSocket connection ───────────────────────────── */
        connect: function (token) {
            try {
                this.socket = io(this.config.websocketUrl, {
                    transports: ['websocket', 'polling'],
                    reconnection: false  // we handle reconnect manually
                });

                this.socket.emit('authenticate', { token }, (res) => {
                    if (res.success) {
                        this.isConnected = true;
                        this.reconnectAttempts = 0;     // reset counter on successful auth
                        this.reconnectDelay = RECONNECT_BASE_DELAY;
                        this.updateStatus('Online', true);
                        this.loadMessages();
                    } else {
                        this.updateStatus(res.message || 'Auth failed', false);
                        this.scheduleReconnect();
                    }
                });

                this.socket.on('new_message',       (data) => this.onNewMessage(data));
                this.socket.on('message_delivered', (data) => this.onDelivered(data));
                this.socket.on('user_typing',       ()     => this.showTypingIndicator());
                this.socket.on('user_stop_typing',  ()     => this.hideTypingIndicator());
                this.socket.on('disconnect', () => {
                    this.isConnected = false;
                    this.updateStatus('Disconnected – reconnecting…', false);
                    this.scheduleReconnect();
                });

            } catch (err) {
                console.error('ChatWidget: connect error', err);
                this.updateStatus('Connection failed', false);
                this.scheduleReconnect();
            }
        },

        scheduleReconnect: function () {
            if (this.reconnectTimer) return;
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                this.updateStatus('Unable to connect. Please refresh the page.', false);
                return;
            }
            this.reconnectAttempts++;
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                // Reuse the cached token if still valid — avoids hammering generate_chat_token
                const nowSec = Date.now() / 1000;
                if (this.cachedToken && this.cachedTokenExpiry > nowSec + 60) {
                    this.connect(this.cachedToken);
                } else {
                    this.cachedToken = null;
                    this.authenticateAndConnect();
                }
            }, this.reconnectDelay);
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY);
        },

        /* ── message loading ────────────────────────────────── */
        loadMessages: function () {
            // Server sends messages via WebSocket after authentication.
            // If your server emits a 'history' event, handle it here:
            // this.socket.on('history', (msgs) => msgs.forEach(m => this.appendMessage(m)));
        },

        /* ── incoming message handler ───────────────────────── */
        onNewMessage: function (data) {
            this.appendMessage(data);
            if (data.sender_type !== 'end_user') {
                if (this.soundEnabled) playBeep();
                this.incrementUnread();
            }
        },

        /* ── message delivered ack ──────────────────────────── */
        onDelivered: function (data) {
            // Server should emit { message_id } when operator receives the message
            const tick = document.querySelector(`[data-msg-id="${data.message_id}"] .cwg-tick`);
            if (tick) {
                tick.classList.add('cwg-delivered');
                tick.setAttribute('title', 'Delivered');
            }
        },

        /* ── send message ───────────────────────────────────── */
        sendMessage: function () {
            const input = document.getElementById('cwg-input');
            const message = input.value.trim();
            if (!message || !this.isConnected) return;

            const tempId = `msg-${Date.now()}`;

            // Optimistic bubble
            this.appendMessage({
                _tempId:     tempId,
                message:     message,
                sender_type: 'end_user',
                created_at:  new Date().toISOString(),
                status:      'sending'
            });

            this.socket.emit('send_message', { message, message_type: 'text' }, (res) => {
                const bubble = document.querySelector(`[data-temp-id="${tempId}"]`);
                if (res.success) {
                    input.value = '';
                    document.getElementById('cwg-send-btn').disabled = true;
                    this.stopTyping();
                    if (bubble) {
                        bubble.dataset.msgId = res.message_id;
                        const tick = bubble.querySelector('.cwg-tick');
                        if (tick) tick.classList.add('cwg-sent');
                    }
                } else {
                    if (bubble) bubble.classList.add('cwg-msg-failed');
                    // small error toast
                    this.showToast('Failed to send. Tap to retry.');
                }
            });
        },

        /* ── typing ─────────────────────────────────────────── */
        handleTyping: function () {
            if (!this.isConnected) return;
            if (!this.isTyping) {
                this.isTyping = true;
                this.socket.emit('typing');
            }
            clearTimeout(this.typingTimeout);
            this.typingTimeout = setTimeout(() => this.stopTyping(), TYPING_DEBOUNCE);
        },

        stopTyping: function () {
            if (this.isTyping && this.isConnected) {
                this.isTyping = false;
                this.socket.emit('stop_typing');
            }
            clearTimeout(this.typingTimeout);
        },

        /* ── appendMessage ──────────────────────────────────── */
        appendMessage: function (data) {
            const container = document.getElementById('cwg-messages');

            // Remove empty state
            const empty = document.getElementById('cwg-empty');
            if (empty) empty.remove();

            const isUser = data.sender_type === 'end_user';
            const dateStr = data.created_at || new Date().toISOString();
            const label   = dateKey(dateStr);

            // Date separator
            if (label !== this.lastDateLabel) {
                this.lastDateLabel = label;
                const sep = document.createElement('div');
                sep.className = 'cwg-date-sep';
                sep.innerHTML = `<span>${formatDateLabel(dateStr)}</span>`;
                container.appendChild(sep);
            }

            // Bubble wrapper
            const wrap = document.createElement('div');
            wrap.className = `cwg-bubble-wrap ${isUser ? 'cwg-user' : 'cwg-operator'}`;
            if (data._tempId)  wrap.dataset.tempId = data._tempId;
            if (data.message_id) wrap.dataset.msgId = data.message_id;

            // Avatar for operator
            const avatar = isUser ? '' : `
                <div class="cwg-avatar" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
                    </svg>
                </div>`;

            // Delivery tick (user messages only)
            const tick = isUser
                ? `<span class="cwg-tick" title="Sending…">
                       <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                           <polyline points="1 8 5 12 15 4"></polyline>
                       </svg>
                   </span>`
                : '';

            wrap.innerHTML = `
                ${avatar}
                <div class="cwg-bubble" role="article">
                    <div class="cwg-text">${linkify(escapeHtml(data.message))}</div>
                    <div class="cwg-meta">
                        <span class="cwg-time">${formatTime(dateStr)}</span>
                        ${tick}
                    </div>
                </div>
            `;

            container.appendChild(wrap);
            container.scrollTop = container.scrollHeight;
        },

        /* ── typing indicator ───────────────────────────────── */
        showTypingIndicator: function () {
            document.getElementById('cwg-typing-wrap').style.display = 'flex';
            const msgs = document.getElementById('cwg-messages');
            msgs.scrollTop = msgs.scrollHeight;
        },

        hideTypingIndicator: function () {
            document.getElementById('cwg-typing-wrap').style.display = 'none';
        },

        /* ── status bar ─────────────────────────────────────── */
        updateStatus: function (text, connected) {
            const bar = document.getElementById('cwg-status');
            if (!bar) return;
            bar.className = `cwg-status${connected ? ' cwg-connected' : ''}`;
            bar.querySelector('.cwg-status-text').textContent = text;
        },

        /* ── toast ──────────────────────────────────────────── */
        showToast: function (msg) {
            let toast = document.getElementById('cwg-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'cwg-toast';
                document.getElementById('cwg-container').appendChild(toast);
            }
            toast.textContent = msg;
            toast.classList.add('cwg-toast-show');
            clearTimeout(this._toastTimer);
            this._toastTimer = setTimeout(() => toast.classList.remove('cwg-toast-show'), 3000);
        },

        /* ── destroy (SPA cleanup) ──────────────────────────── */
        destroy: function () {
            if (this.socket) this.socket.disconnect();
            clearTimeout(this.reconnectTimer);
            clearTimeout(this.typingTimeout);
            this.cachedToken = null;
            this.cachedTokenExpiry = 0;
            ['cwg-container', 'cwg-toggle', 'cwg-styles'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.remove();
            });
        },

        /* ── styles ─────────────────────────────────────────── */
        addStyles: function () {
            if (document.getElementById('cwg-styles')) return;
            const t = THEMES[this.config.theme] || THEMES.blue;
            const isLeft = this.config.position === 'bottom-left';
            const bubbleLeft  = isLeft ? '0 0 16px 16px' : '0 0 16px 16px';
            const bubbleRight = isLeft ? '16px 0 0 16px' : '16px 0 0 16px';

            const s = document.createElement('style');
            s.id = 'cwg-styles';
            s.textContent = `
                /* ── CSS variables ── */
                :root {
                    --cwg-primary:   ${t.primary};
                    --cwg-secondary: ${t.secondary};
                    --cwg-accent:    ${t.accent};
                    --cwg-bg:        #ffffff;
                    --cwg-surface:   #f4f6f8;
                    --cwg-border:    #e2e8f0;
                    --cwg-text:      #1a202c;
                    --cwg-subtext:   #718096;
                    --cwg-radius:    16px;
                    --cwg-shadow:    0 8px 40px rgba(0,0,0,.18);
                    --cwg-font:      'Segoe UI', system-ui, -apple-system, sans-serif;
                }

                /* ── Container ── */
                #cwg-container {
                    position: fixed;
                    bottom: 90px;
                    ${isLeft ? 'left:20px' : 'right:20px'};
                    width: 360px;
                    max-height: 580px;
                    background: var(--cwg-bg);
                    border-radius: var(--cwg-radius);
                    box-shadow: var(--cwg-shadow);
                    display: flex;
                    flex-direction: column;
                    z-index: 999990;
                    font-family: var(--cwg-font);
                    transform-origin: bottom ${isLeft ? 'left' : 'right'};
                    transform: scale(.85) translateY(12px);
                    opacity: 0;
                    pointer-events: none;
                    transition: transform .28s cubic-bezier(.34,1.56,.64,1),
                                opacity  .22s ease;
                    overflow: hidden;
                    border: 1px solid var(--cwg-border);
                }
                #cwg-container.cwg-open {
                    transform: scale(1) translateY(0);
                    opacity: 1;
                    pointer-events: all;
                }

                /* ── Header ── */
                .cwg-header {
                    background: linear-gradient(135deg, var(--cwg-primary), var(--cwg-secondary));
                    color: #fff;
                    padding: 14px 16px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    flex-shrink: 0;
                }
                .cwg-header-avatar {
                    width: 38px; height: 38px;
                    border-radius: 50%;
                    background: rgba(255,255,255,.2);
                    display: flex; align-items: center; justify-content: center;
                    flex-shrink: 0;
                }
                .cwg-header-avatar svg { width: 22px; height: 22px; fill: #fff; }
                .cwg-header-info { flex: 1; min-width: 0; }
                .cwg-header-title    { font-weight: 700; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .cwg-header-subtitle { font-size: 12px; opacity: .8; margin-top: 2px; }
                .cwg-header-actions  { display: flex; gap: 4px; flex-shrink: 0; }
                .cwg-icon-btn {
                    background: rgba(255,255,255,.15);
                    border: none; color: #fff;
                    width: 32px; height: 32px;
                    border-radius: 50%;
                    cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    transition: background .18s;
                }
                .cwg-icon-btn:hover { background: rgba(255,255,255,.3); }
                .cwg-icon-btn svg   { width: 15px; height: 15px; }

                /* ── Status bar ── */
                .cwg-status {
                    padding: 6px 16px;
                    background: var(--cwg-surface);
                    border-bottom: 1px solid var(--cwg-border);
                    display: flex; align-items: center; gap: 7px;
                    font-size: 12px; color: var(--cwg-subtext);
                    flex-shrink: 0;
                    transition: color .3s;
                }
                .cwg-status-dot {
                    width: 7px; height: 7px;
                    border-radius: 50%;
                    background: var(--cwg-subtext);
                    flex-shrink: 0;
                    transition: background .3s;
                }
                .cwg-status.cwg-connected .cwg-status-dot  { background: #38a169; }
                .cwg-status.cwg-connected .cwg-status-text { color: #2f855a; }

                /* ── Messages ── */
                .cwg-messages {
                    flex: 1;
                    padding: 12px 14px 6px;
                    overflow-y: auto;
                    background: var(--cwg-surface);
                    scroll-behavior: smooth;
                }
                .cwg-messages::-webkit-scrollbar       { width: 4px; }
                .cwg-messages::-webkit-scrollbar-thumb { background: var(--cwg-border); border-radius: 4px; }

                /* ── Empty state ── */
                .cwg-empty-state {
                    display: flex; flex-direction: column;
                    align-items: center; justify-content: center;
                    padding: 30px 20px; gap: 8px;
                    text-align: center;
                }
                .cwg-empty-state svg { width: 72px; height: 72px; opacity: .6; }
                .cwg-empty-state p   { font-weight: 600; color: var(--cwg-text); margin: 0; font-size: 14px; }
                .cwg-empty-state span{ font-size: 12px; color: var(--cwg-subtext); }

                /* ── Date separator ── */
                .cwg-date-sep {
                    display: flex; align-items: center;
                    text-align: center; margin: 10px 0;
                    font-size: 11px; color: var(--cwg-subtext);
                }
                .cwg-date-sep::before,
                .cwg-date-sep::after {
                    content: ''; flex: 1;
                    border-top: 1px solid var(--cwg-border);
                }
                .cwg-date-sep span { padding: 0 10px; }

                /* ── Bubble wrapper ── */
                .cwg-bubble-wrap {
                    display: flex; align-items: flex-end;
                    gap: 6px; margin-bottom: 8px;
                    animation: cwg-fade-up .2s ease both;
                }
                .cwg-bubble-wrap.cwg-user     { flex-direction: row-reverse; }
                .cwg-bubble-wrap.cwg-operator { flex-direction: row; }

                @keyframes cwg-fade-up {
                    from { opacity: 0; transform: translateY(8px); }
                    to   { opacity: 1; transform: translateY(0); }
                }

                /* ── Avatar ── */
                .cwg-avatar {
                    width: 28px; height: 28px;
                    border-radius: 50%;
                    background: var(--cwg-primary);
                    display: flex; align-items: center; justify-content: center;
                    flex-shrink: 0;
                }
                .cwg-avatar svg { width: 16px; height: 16px; fill: #fff; }

                /* ── Bubble ── */
                .cwg-bubble {
                    max-width: 74%;
                    padding: 9px 12px 6px;
                    font-size: 14px; line-height: 1.5;
                    word-break: break-word;
                }
                .cwg-user .cwg-bubble {
                    background: linear-gradient(135deg, var(--cwg-primary), var(--cwg-secondary));
                    color: #fff;
                    border-radius: 16px 16px 4px 16px;
                }
                .cwg-operator .cwg-bubble {
                    background: var(--cwg-bg);
                    color: var(--cwg-text);
                    border-radius: 16px 16px 16px 4px;
                    box-shadow: 0 1px 3px rgba(0,0,0,.08);
                }
                .cwg-msg-failed .cwg-bubble { border: 1.5px solid #e53e3e; }

                /* ── Meta (time + tick) ── */
                .cwg-meta {
                    display: flex; align-items: center;
                    gap: 4px; margin-top: 4px;
                    justify-content: flex-end;
                }
                .cwg-time { font-size: 10px; opacity: .65; }
                .cwg-tick {
                    width: 13px; height: 13px;
                    opacity: .5;
                    transition: opacity .2s, stroke .2s;
                }
                .cwg-tick svg { width: 13px; height: 13px; }
                .cwg-tick.cwg-sent      { opacity: .75; }
                .cwg-tick.cwg-delivered { opacity: 1; stroke: var(--cwg-accent); }

                /* ── Typing indicator ── */
                .cwg-typing-wrap {
                    padding: 6px 14px 4px;
                    background: var(--cwg-surface);
                    display: flex; align-items: center; gap: 8px;
                    flex-shrink: 0;
                    border-top: 1px solid var(--cwg-border);
                }
                .cwg-typing {
                    display: flex; align-items: center; gap: 3px;
                    background: var(--cwg-bg);
                    padding: 7px 11px;
                    border-radius: 14px;
                    box-shadow: 0 1px 3px rgba(0,0,0,.08);
                }
                .cwg-typing span {
                    width: 7px; height: 7px;
                    border-radius: 50%;
                    background: var(--cwg-primary);
                    animation: cwg-bounce 1.3s infinite;
                }
                .cwg-typing span:nth-child(2) { animation-delay: .18s; }
                .cwg-typing span:nth-child(3) { animation-delay: .36s; }
                @keyframes cwg-bounce {
                    0%,60%,100% { transform: translateY(0); }
                    30%         { transform: translateY(-6px); }
                }
                .cwg-typing-label { font-size: 11px; color: var(--cwg-subtext); }

                /* ── Input row ── */
                .cwg-input-row {
                    padding: 12px 14px;
                    background: var(--cwg-bg);
                    border-top: 1px solid var(--cwg-border);
                    display: flex; align-items: center; gap: 8px;
                    flex-shrink: 0;
                }
                #cwg-input {
                    flex: 1;
                    padding: 9px 14px;
                    border: 1.5px solid var(--cwg-border);
                    border-radius: 22px;
                    font-size: 14px;
                    font-family: var(--cwg-font);
                    outline: none;
                    background: var(--cwg-surface);
                    color: var(--cwg-text);
                    transition: border-color .18s;
                }
                #cwg-input:focus { border-color: var(--cwg-primary); background: #fff; }
                #cwg-send-btn {
                    width: 40px; height: 40px;
                    border-radius: 50%;
                    border: none;
                    background: linear-gradient(135deg, var(--cwg-primary), var(--cwg-secondary));
                    color: #fff;
                    cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    flex-shrink: 0;
                    transition: transform .18s, opacity .18s;
                }
                #cwg-send-btn svg { width: 18px; height: 18px; }
                #cwg-send-btn:not(:disabled):hover { transform: scale(1.08); }
                #cwg-send-btn:disabled { opacity: .45; cursor: not-allowed; }

                /* ── Toggle button ── */
                #cwg-toggle {
                    position: fixed;
                    bottom: 20px;
                    ${isLeft ? 'left:20px' : 'right:20px'};
                    width: 56px; height: 56px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, var(--cwg-primary), var(--cwg-secondary));
                    color: #fff;
                    border: none;
                    cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    box-shadow: 0 4px 20px rgba(0,0,0,.2);
                    z-index: 999999;
                    transition: transform .22s cubic-bezier(.34,1.56,.64,1);
                }
                #cwg-toggle svg  { width: 26px; height: 26px; }
                #cwg-toggle:hover { transform: scale(1.1) rotate(-4deg); }

                /* ── Badge ── */
                .cwg-badge {
                    position: absolute;
                    top: -4px; right: -4px;
                    min-width: 18px; height: 18px;
                    background: #e53e3e;
                    color: #fff;
                    border-radius: 9px;
                    font-size: 10px; font-weight: 700;
                    display: flex; align-items: center; justify-content: center;
                    padding: 0 4px;
                    border: 2px solid #fff;
                    animation: cwg-pop .25s cubic-bezier(.34,1.56,.64,1);
                }
                @keyframes cwg-pop {
                    from { transform: scale(0); }
                    to   { transform: scale(1); }
                }

                /* ── Toast ── */
                #cwg-toast {
                    position: absolute;
                    bottom: 70px; left: 50%;
                    transform: translateX(-50%) translateY(10px);
                    background: #1a202c;
                    color: #fff;
                    padding: 7px 14px;
                    border-radius: 20px;
                    font-size: 12px;
                    white-space: nowrap;
                    opacity: 0;
                    transition: opacity .2s, transform .2s;
                    pointer-events: none;
                    z-index: 10;
                }
                #cwg-toast.cwg-toast-show {
                    opacity: 1;
                    transform: translateX(-50%) translateY(0);
                }

                /* ── Mobile ── */
                @media (max-width: 480px) {
                    #cwg-container {
                        bottom: 0; left: 0 !important; right: 0 !important;
                        width: 100%; max-height: 92dvh;
                        border-radius: 20px 20px 0 0;
                        transform-origin: bottom center;
                    }
                }
            `;
            document.head.appendChild(s);
        }
    };

    // Expose
    window.ChatWidget = ChatWidget;

    // SPA teardown helper
    window.destroyChatWidget = function () {
        ChatWidget.destroy();
    };

})(window);
