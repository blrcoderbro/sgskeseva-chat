/**
 * SGSK LiveChat Plugin
 * Embed-token-only widget runtime for partner application chat.
 */

(function() {
    'use strict';

    const defaults = {
        apiEndpoint: 'https://sgskeseva.com/api/partner',
        apiKey: null,
        applicationId: null,
        applicationIdB64: null,
        embedToken: null,
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
        tokenExpiryWarningSeconds: 60,
        inactivityAutoRefreshSeconds: 90,
        docsUrl: 'https://sgskeseva.com/partner/docs.php#embed-token-setup'
    };

    const TOKEN_ERROR_TYPES = {
        invalidEmbedToken: 'invalid-embed-token',
        unauthorizedOrigin: 'unauthorized-origin',
        invalidWebsocketUrl: 'invalid-websocket-url',
        tokenExpired: 'token-expired',
        rateLimited: 'rate-limited',
        network: 'network',
        server: 'server',
        config: 'config'
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
    let currentSocketUrl = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let historyLoaded = false;
    let refreshActionEl = null;
    let sessionNoticeEl = null;
    let expiryWarningTimer = null;
    let expiryTimer = null;
    let sessionExpiresAt = null;
    let lastInteractionAt = Date.now();
    let generatedNonces = [];
    let operatorConnectionNotified = false;
    let waitingSinceAt = 0;
    let waitingEtaTimer = null;
    let waitingQueueBeforeCount = null;
    let waitingEtaMinMinutes = null;
    let waitingEtaMaxMinutes = null;
    let statusPollTimer = null;
    let statusEventKey = '';
    let userTypingActive = false;
    let userTypingIdleTimer = null;

    function getScriptTag() {
        return document.currentScript || document.querySelector('script[src*="chat-plugin"]');
    }

    function trackInteraction() {
        lastInteractionAt = Date.now();
    }

    function readDataConfig() {
        const script = getScriptTag();
        if (!script) return {};

        return {
            apiEndpoint: script.getAttribute('data-api-endpoint'),
            apiKey: script.getAttribute('data-api-key'),
            applicationId: script.getAttribute('data-application-id'),
            applicationIdB64: script.getAttribute('data-application-id-b64'),
            embedToken: script.getAttribute('data-embed-token'),
            userName: script.getAttribute('data-user-name'),
            theme: script.getAttribute('data-theme'),
            title: script.getAttribute('data-title'),
            subtitle: script.getAttribute('data-subtitle'),
            position: script.getAttribute('data-position'),
            primaryColor: script.getAttribute('data-primary-color'),
            secondaryColor: script.getAttribute('data-secondary-color'),
            companyName: script.getAttribute('data-company-name'),
            autoLaunch: script.getAttribute('data-auto-launch'),
            soundEnabled: script.getAttribute('data-sound-enabled'),
            docsUrl: script.getAttribute('data-docs-url')
        };
    }

    function base64UrlEncode(value) {
        try {
            return btoa(unescape(encodeURIComponent(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
        } catch (error) {
            return '';
        }
    }

    function base64UrlDecode(value) {
        try {
            let normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
            while (normalized.length % 4) normalized += '=';
            return decodeURIComponent(escape(atob(normalized)));
        } catch (error) {
            return '';
        }
    }

    function encodeApplicationIdB64(applicationId) {
        const id = parseInt(applicationId, 10);
        if (!id || id <= 0) return null;
        return 'app_' + base64UrlEncode('app:' + String(id));
    }

    function decodeApplicationIdB64(applicationIdB64) {
        let encoded = String(applicationIdB64 || '').trim();
        if (!encoded) return null;
        if (encoded.indexOf('app_') === 0) {
            encoded = encoded.slice(4);
        }
        const decoded = base64UrlDecode(encoded);
        const parts = decoded.split(':');
        if (parts.length !== 2 || parts[0] !== 'app') return null;
        const id = parseInt(parts[1], 10);
        return id > 0 ? id : null;
    }

    function normalizeConfig(input) {
        const merged = Object.assign({}, defaults, window.SGSKChatConfig || {}, readDataConfig(), input || {});

        merged.apiKey = merged.apiKey ? String(merged.apiKey).trim() : null;
        merged.applicationId = merged.applicationId ? String(merged.applicationId).trim() : null;
        merged.applicationIdB64 = merged.applicationIdB64 ? String(merged.applicationIdB64).trim() : null;
        merged.embedToken = merged.embedToken ? String(merged.embedToken).trim() : null;
        merged.userName = merged.userName ? String(merged.userName).trim() : defaults.userName;
        merged.autoLaunch = merged.autoLaunch !== false && merged.autoLaunch !== 'false';
        merged.soundEnabled = merged.soundEnabled !== false && merged.soundEnabled !== 'false';
        merged.tokenExpiryWarningSeconds = Math.max(15, parseInt(merged.tokenExpiryWarningSeconds, 10) || defaults.tokenExpiryWarningSeconds);
        merged.inactivityAutoRefreshSeconds = Math.max(30, parseInt(merged.inactivityAutoRefreshSeconds, 10) || defaults.inactivityAutoRefreshSeconds);

        if (!merged.applicationIdB64 && merged.applicationId) {
            merged.applicationIdB64 = encodeApplicationIdB64(merged.applicationId);
        }

        if ((!merged.applicationId || String(merged.applicationId).trim() === '') && merged.applicationIdB64) {
            const decodedId = decodeApplicationIdB64(merged.applicationIdB64);
            if (decodedId) {
                merged.applicationId = String(decodedId);
            }
        }

        return merged;
    }

    function ensureRequiredConfig(nextConfig) {
        const modernModeReady = !!(nextConfig.apiKey && nextConfig.applicationIdB64);
        const legacyModeReady = !!(nextConfig.applicationId && nextConfig.embedToken);
        if (!modernModeReady && !legacyModeReady) {
            const message = 'Missing required chat setup. Preferred: data-api-key + data-application-id-b64. Legacy: data-application-id + data-embed-token. Setup help: ' + nextConfig.docsUrl;
            const error = new Error(message);
            error.type = TOKEN_ERROR_TYPES.config;
            throw error;
        }

        if (legacyModeReady && !modernModeReady) {
            console.warn('[SGSK Chat] Legacy embed-token initialization is deprecated. Use data-api-key + data-application-id-b64.');
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
                <div class="sgsk-launch-button-inner" style="width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,${config.primaryColor},${config.secondaryColor});box-shadow:0 8px 32px rgba(0,0,0,.12);transition:all .2s ease-out;position:relative;">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                </div>
                <div id="sgsk-unread-badge" style="display:none;position:absolute;top:-6px;${isLeft ? 'right' : 'left'}:-6px;min-width:22px;height:22px;padding:0 6px;border-radius:999px;background:#ef4444;color:#fff;font:700 12px/22px Arial,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.18);">0</div>
            </div>
            <div id="sgsk-chat-window" style="display:none;position:fixed;bottom:92px;${isLeft ? 'left' : 'right'}:20px;width:360px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 112px);background:#fff;border-radius:16px;box-shadow:0 18px 48px rgba(0,0,0,.22);z-index:999999;overflow:hidden;flex-direction:column;font-family:Arial,sans-serif;">
                <div style="padding:16px;background:linear-gradient(135deg,${config.primaryColor},${config.secondaryColor});color:#fff;display:flex;align-items:center;justify-content:space-between;gap:10px;">
                    <div>
                        <div style="font-size:16px;font-weight:700;">${escapeHtml(config.title || config.companyName)}</div>
                    </div>
                    <button id="sgsk-close-chat" type="button" style="background:none;border:none;color:#fff;font-size:24px;cursor:pointer;line-height:1;">&times;</button>
                </div>
                <div id="sgsk-chat-status" class="sgsk-chat-status-bar" style="padding:10px 14px;background:#eff6ff;color:#1d4ed8;font-size:12px;border-bottom:1px solid #dbeafe;">Ready to connect</div>
                <div id="sgsk-chat-session-notice" style="display:none;padding:10px 14px;background:#fffbeb;color:#92400e;font-size:12px;border-bottom:1px solid #fde68a;"></div>
                <div id="sgsk-chat-messages" style="flex:1;overflow-y:auto;padding:16px;background:#f8fafc;">
                    <div style="text-align:center;margin:8px 0 18px;">
                        <div style="display:inline-block;background:#fff;border-radius:12px;padding:12px 14px;color:#334155;box-shadow:0 2px 10px rgba(0,0,0,.06);">${escapeHtml(config.theme === 'light' ? 'Open chat to connect to your application operator.' : 'Open chat to connect to your application operator.')}</div>
                    </div>
                    <div id="sgsk-typing-indicator" style="display:none;margin:8px 0 0 0;">
                        <div style="display:inline-block;background:#fff;border-radius:14px;padding:10px 12px;box-shadow:0 2px 10px rgba(0,0,0,.06);color:#64748b;font-size:12px;">Operator is typing...</div>
                    </div>
                </div>
                <div style="padding:14px;border-top:1px solid #e2e8f0;background:#fff;">
                    <div id="sgsk-chat-refresh-action" style="display:none;margin:0 0 10px 0;"></div>
                    <form id="sgsk-chat-form" style="display:flex;gap:8px;align-items:center;">
                        <input id="sgsk-file-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf" style="display:none;" />
                        <button id="sgsk-attach-btn" type="button" style="border:none;background:none;cursor:pointer;padding:4px 6px;color:#64748b;flex-shrink:0;" title="Attach file">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.49"/></svg>
                        </button>
                        <input id="sgsk-chat-input" type="text" placeholder="Waiting for operator..." disabled style="flex:1;padding:11px 14px;border:1px solid #cbd5e1;border-radius:999px;outline:none;font-size:14px;background:#f8fafc;" />
                        <button id="sgsk-chat-send" type="submit" disabled style="border:none;background:${config.primaryColor};color:#fff;border-radius:999px;padding:11px 16px;cursor:pointer;opacity:.55;">
                            Send
                        </button>
                    </form>
                    <div id="sgsk-upload-error" style="display:none;padding:4px 14px 8px;font-size:11px;color:#b91c1c;"></div>
                </div>
            </div>
            <style>
                #sgsk-chat-button .sgsk-launch-button-inner:hover { transform: scale(1.05); box-shadow: 0 12px 40px rgba(99, 102, 241, .5); }
                #sgsk-chat-button .sgsk-launch-button-inner { animation: sgsk-pulse-ring 2s ease-out infinite; }
                @keyframes sgsk-pulse-ring {
                    0% { box-shadow: 0 8px 32px rgba(0, 0, 0, .12); }
                    50% { box-shadow: 0 8px 40px rgba(99, 102, 241, .3); }
                    100% { box-shadow: 0 8px 32px rgba(0, 0, 0, .12); }
                }
                #sgsk-close-chat:hover { background: rgba(255,255,255,.15); }
                #sgsk-chat-window { animation: sgsk-slide-in .3s ease-out; }
                @keyframes sgsk-slide-in {
                    from { opacity: 0; transform: translateY(20px) scale(.95); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                #sgsk-chat-input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, .1); }
                #sgsk-chat-send:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(99, 102, 241, .4); }
                #sgsk-attach-btn:hover { background: #f1f5f9; color: #475569; }
                #sgsk-chat-messages::-webkit-scrollbar { width: 6px; }
                #sgsk-chat-messages::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 999px; }
                .sgsk-message-row.sent .sgsk-message-bubble { border-radius: 12px 12px 4px 12px; }
                .sgsk-message-row.received .sgsk-message-bubble { border-radius: 12px 12px 12px 4px; }
                .sgsk-typing-bubble span { animation: sgsk-typing-dot 1.4s infinite ease-in-out both; }
                .sgsk-typing-bubble span:nth-child(1) { animation-delay: -0.32s; }
                .sgsk-typing-bubble span:nth-child(2) { animation-delay: -0.16s; }
                .sgsk-typing-bubble span:nth-child(3) { animation-delay: 0s; }
                @keyframes sgsk-typing-dot {
                    0%, 80%, 100% { transform: scale(.6); opacity: .5; }
                    40% { transform: scale(1); opacity: 1; }
                }
                @media (max-width: 768px) {
                    #sgsk-chat-window {
                        width: 100%;
                        max-width: none;
                        height: 100vh;
                        max-height: none;
                        bottom: 0;
                        right: 0;
                        left: 0;
                        border-radius: 0;
                    }
                    #sgsk-chat-button {
                        bottom: 16px;
                        right: 16px;
                    }
                }
                @keyframes sgsk-slide-up {
                    from { transform: translateY(8px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
                @keyframes sgsk-dots {
                    0%, 80%, 100% { opacity: 0.3; }
                    40% { opacity: 1; }
                }
                #sgsk-chat-status { display: flex; align-items: center; min-height: 44px; }
                #sgsk-chat-status .sgsk-status-icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; margin-right: 8px; flex-shrink: 0; }
                #sgsk-chat-status.sgsk-state-waiting .sgsk-status-icon { animation: sgsk-pulse 1.5s ease-in-out infinite; }
                #sgsk-chat-status.sgsk-state-joined { animation: sgsk-slide-up 0.3s ease-out; }
                #sgsk-chat-status.sgsk-state-reconnecting .sgsk-status-dot { animation: sgsk-dots 1.4s ease-in-out infinite; }
                #sgsk-chat-status.sgsk-state-reconnecting .sgsk-status-dot:nth-child(2) { animation-delay: 0.2s; }
                #sgsk-chat-status.sgsk-state-reconnecting .sgsk-status-dot:nth-child(3) { animation-delay: 0.4s; }
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
        refreshActionEl = document.getElementById('sgsk-chat-refresh-action');
        sessionNoticeEl = document.getElementById('sgsk-chat-session-notice');

        document.getElementById('sgsk-chat-button').addEventListener('click', function() {
            trackInteraction();
            toggle();
        });
        document.getElementById('sgsk-close-chat').addEventListener('click', close);
        formEl.addEventListener('submit', sendMessage);
        document.getElementById('sgsk-attach-btn').addEventListener('click', function() {
            trackInteraction();
            document.getElementById('sgsk-file-input').click();
        });
        document.getElementById('sgsk-file-input').addEventListener('change', handleFileSelect);
        inputEl.addEventListener('input', function() {
            trackInteraction();
            if (!inputEl) return;
            if (String(inputEl.value || '').trim()) emitUserTyping();
            else emitUserStopTyping();
        });
        inputEl.addEventListener('blur', function() {
            emitUserStopTyping();
        });
        inputEl.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                sendMessage(event);
            }
        });
    }

    function appendSystemMessage(text, options) {
        if (!messagesEl) return;
        const el = document.createElement('div');
        el.style.cssText = 'margin:10px 0;text-align:center;font-size:12px;color:#64748b;';
        el.textContent = text;
        if (options && options.key) {
            el.setAttribute('data-system-key', String(options.key));
        }
        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function clearSystemMessageByKey(key) {
        if (!messagesEl || !key) return;
        const nodes = messagesEl.querySelectorAll('[data-system-key="' + String(key) + '"]');
        for (let i = 0; i < nodes.length; i += 1) {
            nodes[i].remove();
        }
    }

    function appendMessage(text, type) {
        if (!messagesEl) return;
        const row = document.createElement('div');
        row.className = 'sgsk-message-row ' + type;
        row.style.cssText = 'margin:10px 0;text-align:' + (type === 'sent' ? 'right' : 'left') + ';';
        const bubble = document.createElement('div');
        bubble.className = 'sgsk-message-bubble';
        bubble.style.cssText = 'display:inline-block;max-width:82%;padding:10px 14px;word-break:break-word;';
        if (type === 'sent') {
            bubble.style.background = 'linear-gradient(135deg, #6366f1 0%,  #4f46e5 100%)';
            bubble.style.color = 'white';
            bubble.style.boxShadow = '0 2px 8px rgba(99, 102, 241, 0.3)';
            bubble.style.borderRadius = '12px 12px 4px 12px';
        } else {
            bubble.style.background = '#fff';
            bubble.style.color = '#0f172a';
            bubble.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.08)';
            bubble.style.borderRadius = '12px 12px 12px 4px';
        }
        bubble.textContent = text;
        row.appendChild(bubble);
        messagesEl.insertBefore(row, typingEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendAttachmentMessage(url, filename, type, previewDataUrl, attachmentDataBase64) {
        if (!messagesEl) return;
        const row = document.createElement('div');
        row.className = 'sgsk-message-row ' + type;
        row.style.cssText = 'margin:10px 0;text-align:' + (type === 'sent' ? 'right' : 'left') + ';';

        const normalizedPreview = String(previewDataUrl || '').trim();
        const normalizedAttachmentData = String(attachmentDataBase64 || '').trim();
        const normalizedUrl = String(url || '').trim();
        const decodedPreviewImage = decodeImageDataUrlToBlobUrl(normalizedPreview);
        const decodedAttachmentImage = decodeImageDataUrlToBlobUrl(normalizedAttachmentData);
        const imageSrc = decodedPreviewImage || decodedAttachmentImage || normalizedUrl;
        const isImage = Boolean(decodedPreviewImage || decodedAttachmentImage) || /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i.test(normalizedUrl);
        let content = '';

        if (isImage) {
            const linkUrl = (/^(blob:|data:image\/)/i.test(imageSrc) ? imageSrc : (normalizedUrl || imageSrc));
            content = '<a href="' + escapeHtml(linkUrl) + '" target="_blank" rel="noopener"><img src="' + escapeHtml(imageSrc) + '" alt="' + escapeHtml(filename || 'Attachment') + '" style="max-width:180px;max-height:180px;border-radius:8px;display:block;" /></a>';
        } else {
            const docHref = normalizedUrl || '#';
            content = '<a href="' + escapeHtml(docHref) + '" target="_blank" rel="noopener" download="' + escapeHtml(filename || 'attachment') + '" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:inherit;">'
                + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
                + '<span style="text-decoration:underline;">' + escapeHtml(filename || 'Attachment') + '</span></a>';
        }

        const bubble = document.createElement('div');
        bubble.className = 'sgsk-message-bubble';
        bubble.style.cssText = 'display:inline-block;max-width:82%;padding:10px 14px;word-break:break-word;';
        if (type === 'sent') {
            bubble.style.background = 'linear-gradient(135deg, #6366f1 0%,  #4f46e5 100%)';
            bubble.style.color = 'white';
            bubble.style.boxShadow = '0 2px 8px rgba(99, 102, 241, 0.3)';
            bubble.style.borderRadius = '12px 12px 4px 12px';
        } else {
            bubble.style.background = '#fff';
            bubble.style.color = '#0f172a';
            bubble.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.08)';
            bubble.style.borderRadius = '12px 12px 12px 4px';
        }
        bubble.innerHTML = content;
        row.appendChild(bubble);
        messagesEl.insertBefore(row, typingEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function decodeImageDataUrlToBlobUrl(dataUrl) {
        const value = String(dataUrl || '').trim();
        if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return '';
        const commaIndex = value.indexOf(',');
        if (commaIndex < 0) return '';
        const mimeMatch = value.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
        const mimeType = mimeMatch && mimeMatch[1] ? mimeMatch[1] : 'image/png';
        const base64Part = value.slice(commaIndex + 1);
        try {
            const binary = atob(base64Part);
            const len = binary.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i += 1) {
                bytes[i] = binary.charCodeAt(i);
            }
            return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        } catch (error) {
            return '';
        }
    }

    function normalizeInboundFileUrl(rawPath) {
        const value = String(rawPath || '').trim();
        if (!value) return '';
        if (/^data:image\//i.test(value)) return value;
        if (/^https?:\/\//i.test(value)) return value;
        // Recover from legacy server payloads that mistakenly include filesystem paths.
        const unixMarker = value.indexOf('/assets/');
        const winMarker = value.toLowerCase().indexOf('\\assets\\');
        let cleanValue = value;
        if (unixMarker >= 0) {
            cleanValue = value.slice(unixMarker);
        } else if (winMarker >= 0) {
            cleanValue = value.slice(winMarker).replace(/\\/g, '/');
        }
        const normalizedPath = cleanValue.charAt(0) === '/' ? cleanValue : ('/' + cleanValue.replace(/^\/+/, ''));
        try {
            const apiBase = new URL(config.apiEndpoint);
            return apiBase.origin + normalizedPath;
        } catch (error) {
            return normalizedPath;
        }
    }

    function inferAttachmentName(msg, fallbackUrl) {
        const provided = String((msg && (msg.message || msg.content)) || '').trim();
        if (provided) return provided;
        const cleaned = String(fallbackUrl || '').split('?')[0];
        const parts = cleaned.split('/');
        return parts.length ? (parts[parts.length - 1] || 'Attachment') : 'Attachment';
    }

    function markOperatorConnected(operatorName, announce) {
        const name = String(operatorName || 'Operator');
        operatorAccepted = true;
        stopWaitingEta();
        stopStatusPolling();
        clearSystemMessageByKey('chat-opening');
        setInputEnabled(true);
        hideSessionNotice();
        setStatus('Connected to ' + name, 'success');
        if (announce && !operatorConnectionNotified) {
            appendSystemMessage(name + ' is online.');
            operatorConnectionNotified = true;
        }
    }

    function setStatus(text, tone) {
        if (!statusEl) return;
        const tones = {
            info: { bg: '#eff6ff', color: '#1d4ed8', border: '#dbeafe', icon: '', stateClass: '' },
            waiting: {
                bg: '#fff7ed', color: '#c2410c', border: '#fed7aa', stateClass: 'sgsk-state-waiting',
                icon: '<span class="sgsk-status-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>'
            },
            success: {
                bg: '#ecfdf5', color: '#047857', border: '#a7f3d0', stateClass: 'sgsk-state-joined',
                icon: '<span class="sgsk-status-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></span>'
            },
            completed: {
                bg: '#f0fdfa', color: '#0f766e', border: '#99f6e4', stateClass: 'sgsk-state-completed',
                icon: '<span class="sgsk-status-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span>'
            },
            reconnecting: {
                bg: '#f9fafb', color: '#6b7280', border: '#e5e7eb', stateClass: 'sgsk-state-reconnecting',
                icon: '<span class="sgsk-status-icon"><span class="sgsk-status-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin:0 2px;"></span><span class="sgsk-status-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin:0 2px;"></span><span class="sgsk-status-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin:0 2px;"></span></span>'
            },
            error: { bg: '#fef2f2', color: '#b91c1c', border: '#fecaca', icon: '', stateClass: '' }
        };
        const palette = tones[tone] || tones.info;
        statusEl.className = 'sgsk-chat-status-bar' + (palette.stateClass ? ' ' + palette.stateClass : '');
        statusEl.innerHTML = (palette.icon || '') + '<span>' + escapeHtml(text) + '</span>';
        statusEl.style.background = palette.bg;
        statusEl.style.color = palette.color;
        statusEl.style.borderBottom = '1px solid ' + palette.border;
    }

    function setInputEnabled(enabled) {
        if (!inputEl) return;
        const sendButton = document.getElementById('sgsk-chat-send');
        const attachBtn = document.getElementById('sgsk-attach-btn');
        inputEl.disabled = !enabled;
        sendButton.disabled = !enabled;
        sendButton.style.opacity = enabled ? '1' : '.55';
        inputEl.placeholder = enabled ? 'Type a message...' : 'Waiting for operator...';
        inputEl.style.background = enabled ? '#fff' : '#f8fafc';
        if (attachBtn) {
            attachBtn.disabled = !enabled;
            attachBtn.style.opacity = enabled ? '1' : '.4';
            attachBtn.style.pointerEvents = enabled ? 'auto' : 'none';
        }
    }

    function showSessionNotice(message, tone) {
        if (!sessionNoticeEl) return;
        const palette = tone === 'error'
            ? { bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' }
            : { bg: '#fffbeb', color: '#92400e', border: '#fde68a' };
        sessionNoticeEl.style.display = 'block';
        sessionNoticeEl.style.background = palette.bg;
        sessionNoticeEl.style.color = palette.color;
        sessionNoticeEl.style.borderBottom = '1px solid ' + palette.border;
        sessionNoticeEl.textContent = message;
    }

    function hideSessionNotice() {
        if (!sessionNoticeEl) return;
        sessionNoticeEl.style.display = 'none';
        sessionNoticeEl.textContent = '';
    }

    function showRefreshAction(label, message) {
        if (!refreshActionEl) return;
        refreshActionEl.style.display = 'block';
        refreshActionEl.innerHTML = '';

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'padding:10px 12px;border:1px solid #dbeafe;background:#f8fbff;border-radius:12px;font-size:12px;color:#334155;display:flex;align-items:center;justify-content:space-between;gap:10px;';
        const textEl = document.createElement('div');
        textEl.textContent = message;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label || 'Refresh';
        button.style.cssText = 'border:none;border-radius:999px;padding:8px 12px;background:' + config.primaryColor + ';color:#fff;cursor:pointer;font-size:12px;white-space:nowrap;';
        button.addEventListener('click', function() {
            trackInteraction();
            reinitialize();
        });

        wrapper.appendChild(textEl);
        wrapper.appendChild(button);
        refreshActionEl.appendChild(wrapper);
    }

    function hideRefreshAction() {
        if (!refreshActionEl) return;
        refreshActionEl.style.display = 'none';
        refreshActionEl.innerHTML = '';
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

    function isTokenRefreshAllowed() {
        return !!(config && config.applicationId && (config.embedToken || (config.apiKey && config.applicationIdB64)));
    }

    function open() {
        trackInteraction();
        chatWindow.style.display = 'flex';
        resetUnread();
        if (!socket) {
            if (!historyLoaded && (sessionToken || config.embedToken)) {
                fetchChatHistory().then(function(messages) {
                    historyLoaded = true;
                    renderHistory(messages);
                    connect();
                });
            } else {
                connect();
            }
        } else if (!historyLoaded && sessionToken) {
            fetchChatHistory().then(function(messages) {
                historyLoaded = true;
                renderHistory(messages);
            });
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

    function generateNonce() {
        let nonce = null;
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            nonce = window.crypto.randomUUID();
        } else if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            const buffer = new Uint8Array(16);
            window.crypto.getRandomValues(buffer);
            nonce = Array.prototype.map.call(buffer, function(value) {
                return value.toString(16).padStart(2, '0');
            }).join('');
        } else {
            nonce = 'nonce-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        }

        generatedNonces.push(nonce);
        if (generatedNonces.length > 20) {
            generatedNonces = generatedNonces.slice(-20);
        }
        return nonce;
    }

    function isValidWebsocketUrl(value) {
        if (!value) return false;
        try {
            const parsed = new URL(value, window.location.href);
            return parsed.protocol === 'wss:' || parsed.protocol === 'ws:';
        } catch (error) {
            return false;
        }
    }

    function createFriendlyError(message, type, shouldOfferRefresh) {
        const error = new Error(message);
        error.type = type || TOKEN_ERROR_TYPES.server;
        error.shouldOfferRefresh = !!shouldOfferRefresh;
        return error;
    }

    function handleInitializationError(error) {
        const message = error && error.message ? error.message : 'Unable to initialize chat.';
        const type = error && error.type ? error.type : TOKEN_ERROR_TYPES.server;

        resetConnectionState();
        clearReconnectTimer();
        clearTokenTimers();
        cleanupSocket();

        if (type === TOKEN_ERROR_TYPES.unauthorizedOrigin) {
            setStatus('This domain is not authorized for this application.', 'error');
            appendSystemMessage('This domain is not authorized for this application. Please contact your administrator.');
            showRefreshAction('Refresh', 'If the embed token was updated for this domain, refresh the chat session.');
            return;
        }

        if (type === TOKEN_ERROR_TYPES.invalidEmbedToken) {
            setStatus('Embed token expired or invalid.', 'error');
            appendSystemMessage('Embed token expired or invalid. Please regenerate from partner portal.');
            showRefreshAction('Refresh', 'Refresh after updating the page with a new embed token.');
            return;
        }

        if (type === TOKEN_ERROR_TYPES.invalidWebsocketUrl) {
            setStatus('Unable to connect. Please refresh the page or contact support.', 'error');
            appendSystemMessage('Unable to connect. Please refresh the page or contact support.');
            showRefreshAction('Refresh', 'Try to reconnect using an updated chat session.');
            return;
        }

        if (type === TOKEN_ERROR_TYPES.tokenExpired) {
            setStatus('Session expired. Refresh to continue.', 'error');
            appendSystemMessage('Session expired. Refresh to continue.');
            showRefreshAction('Refresh', 'Refresh to create a new secure chat session.');
            return;
        }

        if (type === TOKEN_ERROR_TYPES.rateLimited) {
            setStatus('Too many chat session requests. Please wait and retry.', 'error');
            appendSystemMessage(message);
            showRefreshAction('Refresh', 'Wait for the cooldown, then refresh the chat session.');
            return;
        }

        if (type === TOKEN_ERROR_TYPES.config) {
            setStatus('Chat setup is incomplete.', 'error');
            appendSystemMessage(message);
            showRefreshAction('Refresh', 'After updating the script attributes, refresh the chat session.');
            return;
        }

        setStatus('Unable to connect right now. Please try again shortly.', 'error');
        appendSystemMessage(message);
        if (error && error.shouldOfferRefresh !== false) {
            showRefreshAction('Refresh', 'Refresh the chat session after the network or service issue is resolved.');
        }
    }

    function fetchChatToken() {
        const useModernBootstrap = !!(config.apiKey && config.applicationIdB64 && !config.embedToken);
        const endpoint = useModernBootstrap ? '/bootstrap_chat' : '/generate_chat_token';
        const body = useModernBootstrap
            ? {
                api_key: config.apiKey,
                application_id_b64: config.applicationIdB64,
                proof_nonce: generateNonce()
            }
            : {
                application_id_b64: config.applicationIdB64,
                application_id: Number(config.applicationId),
                embed_token: config.embedToken,
                proof_nonce: generateNonce()
            };

        return fetch(config.apiEndpoint.replace(/\/$/, '') + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(async function(res) {
            const data = await res.json().catch(function() { return {}; });

            if (res.status === 401) {
                throw createFriendlyError('Embed token expired or invalid. Please regenerate from partner portal.', TOKEN_ERROR_TYPES.invalidEmbedToken, true);
            }

            if (res.status === 403) {
                const serverMessage = String((data && data.message) || '').toLowerCase();
                if (serverMessage.indexOf('origin') !== -1 || serverMessage.indexOf('domain') !== -1 || serverMessage.indexOf('allowed') !== -1 || serverMessage.indexOf('authorized') !== -1) {
                    throw createFriendlyError('This domain is not authorized for this application. Please contact your administrator.', TOKEN_ERROR_TYPES.unauthorizedOrigin, true);
                }
                throw createFriendlyError('Unable to start chat from this page. Please contact your administrator.', TOKEN_ERROR_TYPES.server, true);
            }

            if (res.status === 429) {
                const retryAfterRaw = res.headers.get('Retry-After');
                const retryAfter = parseInt(retryAfterRaw || '0', 10);
                const waitHint = retryAfter > 0
                    ? (' Please retry after ' + retryAfter + ' seconds.')
                    : '';
                throw createFriendlyError('Too many chat bootstrap requests.' + waitHint, TOKEN_ERROR_TYPES.rateLimited, true);
            }

            if (!res.ok) {
                if (res.status >= 500) {
                    throw createFriendlyError('The chat service is temporarily unavailable. Please try again shortly.', TOKEN_ERROR_TYPES.server, true);
                }
                throw createFriendlyError((data && data.message) || 'Unable to start chat right now.', TOKEN_ERROR_TYPES.server, true);
            }

            const tokenValue = (data && data.data && (data.data.token || data.data.chat_token)) || '';
            if (!data.success || !data.data || !tokenValue) {
                throw createFriendlyError((data && data.message) || 'Unable to create a secure chat session.', TOKEN_ERROR_TYPES.server, true);
            }

            if (!isValidWebsocketUrl(data.data.websocket_url)) {
                throw createFriendlyError('Unable to connect. Please refresh the page or contact support.', TOKEN_ERROR_TYPES.invalidWebsocketUrl, true);
            }

            data.data.token = tokenValue;
            if (!data.data.application_id_b64 && config.applicationIdB64) {
                data.data.application_id_b64 = config.applicationIdB64;
            }
            if ((!config.applicationId || String(config.applicationId).trim() === '') && data.data.application_id) {
                config.applicationId = String(data.data.application_id);
            }
            if ((!config.applicationId || String(config.applicationId).trim() === '') && data.data.application_id_b64) {
                const decoded = decodeApplicationIdB64(data.data.application_id_b64);
                if (decoded) config.applicationId = String(decoded);
            }
            return data.data;
        }).catch(function(error) {
            if (error && error.type) {
                throw error;
            }
            throw createFriendlyError('Network issue detected. Please check your connection and refresh the page.', TOKEN_ERROR_TYPES.network, true);
        });
    }

    function fetchChatHistory() {
        const tokenParam = sessionToken || config.embedToken || '';
        if (!tokenParam || (!config.applicationId && !config.applicationIdB64)) {
            return Promise.resolve([]);
        }

        const appQuery = config.applicationIdB64
            ? 'application_id_b64=' + encodeURIComponent(config.applicationIdB64)
            : 'application_id=' + encodeURIComponent(config.applicationId);
        const url = config.apiEndpoint.replace(/\/$/, '') + '/chat_history?' + appQuery + '&token=' + encodeURIComponent(tokenParam);

        return fetch(url, { method: 'GET' })
            .then(function(res) {
                if (res.status === 401) {
                    handleInitializationError(createFriendlyError('Embed token expired or invalid. Please regenerate from partner portal.', TOKEN_ERROR_TYPES.invalidEmbedToken, true));
                    return [];
                }
                if (res.status === 403) {
                    handleInitializationError(createFriendlyError('This domain is not authorized for this application. Please contact your administrator.', TOKEN_ERROR_TYPES.unauthorizedOrigin, true));
                    return [];
                }
                if (!res.ok) {
                    return [];
                }
                return res.json().then(function(data) {
                    return (data && data.success && data.data && Array.isArray(data.data.messages)) ? data.data.messages : [];
                });
            })
            .catch(function() {
                return [];
            });
    }

    function renderHistory(messages) {
        if (!messages || !messages.length) {
            return;
        }

        messages.forEach(function(msg) {
            const type = msg.role === 'user' ? 'sent' : 'received';
            const attachmentUrl = normalizeInboundFileUrl(msg.attachment_url || msg.file_path || '');
            const previewData = normalizeInboundFileUrl(msg.attachment_preview_data || '');
            const attachmentDataBase64 = String(msg.attachment_data_base64 || '').trim();
            if ((attachmentUrl || previewData || attachmentDataBase64) && typeof appendAttachmentMessage === 'function') {
                appendAttachmentMessage(attachmentUrl || previewData || attachmentDataBase64, msg.message, type, previewData, attachmentDataBase64);
            } else {
                appendMessage(msg.message || (attachmentUrl ? '[Attachment]' : ''), type);
            }
        });

        const sep = document.createElement('div');
        sep.style.cssText = 'margin:14px 0;text-align:center;font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:8px;';
        sep.innerHTML = '<span style="flex:1;height:1px;background:#e2e8f0;"></span><span>-- Earlier messages --</span><span style="flex:1;height:1px;background:#e2e8f0;"></span>';
        messagesEl.insertBefore(sep, typingEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function clearReconnectTimer() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }

    function clearTokenTimers() {
        if (expiryWarningTimer) {
            clearTimeout(expiryWarningTimer);
            expiryWarningTimer = null;
        }
        if (expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimer = null;
        }
    }

    function stopWaitingEta() {
        if (waitingEtaTimer) {
            clearInterval(waitingEtaTimer);
            waitingEtaTimer = null;
        }
        waitingSinceAt = 0;
        waitingQueueBeforeCount = null;
        waitingEtaMinMinutes = null;
        waitingEtaMaxMinutes = null;
    }

    function updateWaitingEtaStatus() {
        if (!isAuthenticated || operatorAccepted) return;
        if (
            waitingQueueBeforeCount !== null &&
            waitingEtaMinMinutes !== null &&
            waitingEtaMaxMinutes !== null
        ) {
            setStatus(
                'Finding an operator... Queue before you: ' + waitingQueueBeforeCount + '. Estimated wait: ' + waitingEtaMinMinutes + '-' + waitingEtaMaxMinutes + ' min',
                'waiting'
            );
            return;
        }
        const elapsedSec = Math.max(0, Math.floor((Date.now() - waitingSinceAt) / 1000));
        const elapsedMin = Math.max(1, Math.floor(elapsedSec / 60));
        setStatus('Finding an operator... Estimating queue (' + elapsedMin + ' min elapsed)', 'waiting');
    }

    function startWaitingEta() {
        stopWaitingEta();
        waitingSinceAt = Date.now();
        updateWaitingEtaStatus();
        waitingEtaTimer = window.setInterval(updateWaitingEtaStatus, 5000);
    }

    function stopStatusPolling() {
        if (statusPollTimer) {
            clearInterval(statusPollTimer);
            statusPollTimer = null;
        }
    }

    function pollApplicationStatus() {
        if (!config || !config.apiKey || !config.applicationIdB64) return;
        const endpoint = config.apiEndpoint.replace(/\/$/, '') + '/application_status';
        fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: config.apiKey,
                application_id_b64: config.applicationIdB64
            })
        }).then(function(res) {
            if (!res.ok) return null;
            return res.json().catch(function() { return null; });
        }).then(function(payload) {
            if (!payload || !payload.success || !payload.data) return;
            const queueBeforeRaw = parseInt(payload.data.queue_before_count, 10);
            const etaMinRaw = parseInt(payload.data.estimated_wait_min_minutes, 10);
            const etaMaxRaw = parseInt(payload.data.estimated_wait_max_minutes, 10);
            if (!isNaN(queueBeforeRaw)) waitingQueueBeforeCount = Math.max(0, queueBeforeRaw);
            if (!isNaN(etaMinRaw)) waitingEtaMinMinutes = Math.max(0, etaMinRaw);
            if (!isNaN(etaMaxRaw)) waitingEtaMaxMinutes = Math.max(0, etaMaxRaw);
            if (!operatorAccepted) updateWaitingEtaStatus();

            const appStatus = String(payload.data.status || '').toLowerCase();
            if (!appStatus) return;
            if (statusEventKey === appStatus) return;

            if (appStatus === 'completed' || appStatus === 'success' || appStatus === 'approved') {
                statusEventKey = appStatus;
                clearSystemMessageByKey('txn-status');
                appendSystemMessage('Transaction status: SUCCESS', { key: 'txn-status' });
                setStatus('Application completed successfully.', 'completed');
                setInputEnabled(false);
                stopWaitingEta();
                stopStatusPolling();
            } else if (appStatus === 'rejected' || appStatus === 'failed' || appStatus === 'declined') {
                statusEventKey = appStatus;
                clearSystemMessageByKey('txn-status');
                appendSystemMessage('Transaction status: REJECTED', { key: 'txn-status' });
                setStatus('Application was rejected.', 'error');
                setInputEnabled(false);
                stopWaitingEta();
                stopStatusPolling();
            }
        }).catch(function() {
        });
    }

    function startStatusPolling() {
        stopStatusPolling();
        pollApplicationStatus();
        statusPollTimer = window.setInterval(pollApplicationStatus, 12000);
    }

    function emitUserStopTyping() {
        if (!socket || !isAuthenticated || !operatorAccepted || !userTypingActive) return;
        socket.emit('stop_typing');
        userTypingActive = false;
    }

    function emitUserTyping() {
        if (!socket || !isAuthenticated || !operatorAccepted) return;
        if (!userTypingActive) {
            socket.emit('typing');
            userTypingActive = true;
        }
        if (userTypingIdleTimer) clearTimeout(userTypingIdleTimer);
        userTypingIdleTimer = window.setTimeout(function() {
            emitUserStopTyping();
        }, 1200);
    }

    function resetConnectionState() {
        isAuthenticated = false;
        operatorAccepted = false;
        operatorConnectionNotified = false;
        statusEventKey = '';
        userTypingActive = false;
        if (userTypingIdleTimer) {
            clearTimeout(userTypingIdleTimer);
            userTypingIdleTimer = null;
        }
        stopWaitingEta();
        stopStatusPolling();
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

    function gracefulExpireSession(allowAutoRefresh) {
        clearReconnectTimer();
        clearTokenTimers();
        resetConnectionState();
        cleanupSocket();
        sessionToken = null;
        sessionExpiresAt = null;
        setStatus('Session expired. Refresh to continue.', 'error');
        showSessionNotice('Session expired. Refresh to continue.', 'error');
        appendSystemMessage('Session expired. Refresh to continue.');
        showRefreshAction('Refresh', 'Refresh to create a new secure chat session.');

        const inactiveFor = Date.now() - lastInteractionAt;
        if (allowAutoRefresh && inactiveFor >= (config.inactivityAutoRefreshSeconds * 1000) && isTokenRefreshAllowed()) {
            showSessionNotice('Refreshing your secure chat session...', 'warning');
            reinitialize();
        }
    }

    function scheduleTokenLifecycle(tokenData) {
        clearTokenTimers();

        const expiresIn = Math.max(0, parseInt(tokenData && tokenData.expires_in, 10) || 0);
        sessionExpiresAt = expiresIn > 0 ? Date.now() + (expiresIn * 1000) : null;
        if (!sessionExpiresAt) {
            hideSessionNotice();
            return;
        }

        const warningLead = Math.min(config.tokenExpiryWarningSeconds, Math.max(15, expiresIn - 15));
        const warningDelay = Math.max(0, (expiresIn - warningLead) * 1000);
        const expiryDelay = expiresIn * 1000;

        expiryWarningTimer = window.setTimeout(function() {
            showSessionNotice('Your session will expire soon. Your current messages will be preserved.', 'warning');
            appendSystemMessage('Your session will expire soon. Your current messages will be preserved.');
        }, warningDelay);

        expiryTimer = window.setTimeout(function() {
            gracefulExpireSession(true);
        }, expiryDelay);
    }

    function scheduleReconnect(reason) {
        if (!initialized || reconnectTimer || !sessionToken || (sessionExpiresAt && Date.now() >= sessionExpiresAt)) return;
        reconnectAttempt += 1;
        const delay = Math.min(15000, Math.max(1000, reconnectAttempt * 1500));
        setStatus('Reconnecting... (attempt ' + reconnectAttempt + ')', 'reconnecting');
        appendSystemMessage((reason || 'Connection lost') + ' Retrying in ' + Math.round(delay / 1000) + 's...');
        reconnectTimer = window.setTimeout(function() {
            reconnectTimer = null;
            cleanupSocket();
            connect(false);
        }, delay);
    }

    function hasReusableSession() {
        return !!sessionToken && !!currentSocketUrl && (!sessionExpiresAt || Date.now() < sessionExpiresAt);
    }

    function openSocketConnection(socketUrl) {
        socket = window.io(socketUrl, {
            // Polling-only mode avoids repeated websocket upgrade failures behind restrictive proxies.
            transports: ['polling'],
            upgrade: false,
            reconnection: false,
            query: {
                token: sessionToken || ''
            }
        });
        bindSocketEvents();
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
            hideRefreshAction();
            hideSessionNotice();
            clearSystemMessageByKey('chat-opening');
            setStatus('Connected to chat service. Waiting for operator status...', 'info');
            if (!historyLoaded) {
                fetchChatHistory().then(function(messages) {
                    historyLoaded = true;
                    renderHistory(messages);
                });
            }
            setInputEnabled(false);
            startWaitingEta();
            startStatusPolling();
        });

        socket.on('auth_error', function() {
            gracefulExpireSession(false);
        });

        socket.on('request_accepted', function(evt) {
            if (!evt) return;
            if (String(evt.application_id || evt.id || '') !== String(config.applicationId)) return;
            markOperatorConnected(evt.operator_name || 'Operator', false);
            operatorConnectionNotified = true;
        });

        socket.on('application_completed', function(evt) {
            if (!evt) return;
            if (String(evt.application_id || evt.id || '') !== String(config.applicationId)) return;
            operatorAccepted = false;
            stopWaitingEta();
            stopStatusPolling();
            setInputEnabled(false);
            setStatus('Your application has been processed. Thank you!', 'completed');
            appendSystemMessage('This chat session has ended. Your application has been processed.');
        });

        socket.on('request_completed', function(evt) {
            if (!evt) return;
            if (String(evt.application_id || evt.id || '') !== String(config.applicationId)) return;
            operatorAccepted = false;
            stopWaitingEta();
            stopStatusPolling();
            clearSystemMessageByKey('txn-status');
            appendSystemMessage('Transaction status: SUCCESS', { key: 'txn-status' });
            setInputEnabled(false);
            setStatus('Your application has been processed. Thank you!', 'completed');
        });

        socket.on('request_rejected', function(evt) {
            if (!evt) return;
            if (String(evt.application_id || evt.id || '') !== String(config.applicationId)) return;
            operatorAccepted = false;
            stopWaitingEta();
            stopStatusPolling();
            clearSystemMessageByKey('txn-status');
            appendSystemMessage('Transaction status: REJECTED' + (evt.reason ? (' (' + evt.reason + ')') : ''), { key: 'txn-status' });
            setInputEnabled(false);
            setStatus('Your application was rejected.', 'error');
        });

        socket.on('new_message', function(msg) {
            if (!msg) return;
            if (String(msg.source_id || '') !== String(config.applicationId)) return;
            if (msg.sender_type === 'end_user') return;
            markOperatorConnected(msg.sender_name || 'Operator', false);

            const attachmentUrl = normalizeInboundFileUrl(msg.attachment_url || msg.file_path || '');
            const previewData = normalizeInboundFileUrl(msg.attachment_preview_data || '');
            const attachmentDataBase64 = String(msg.attachment_data_base64 || '').trim();
            if (attachmentUrl || previewData || attachmentDataBase64) {
                appendAttachmentMessage(
                    attachmentUrl || previewData || attachmentDataBase64,
                    inferAttachmentName(msg, attachmentUrl || previewData || attachmentDataBase64),
                    'received',
                    previewData,
                    attachmentDataBase64
                );
            } else {
                appendMessage(msg.message || msg.content || '', 'received');
            }
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
            setStatus('Reconnecting... (attempt ' + (reconnectAttempt + 1) + ')', 'reconnecting');
            scheduleReconnect((err && err.message) ? err.message : 'Connection lost.');
        });

        socket.on('disconnect', function() {
            resetConnectionState();
            setStatus('Reconnecting... (attempt ' + (reconnectAttempt + 1) + ')', 'reconnecting');
            scheduleReconnect('Disconnected from chat service.');
        });
    }

    function connect(forceRefresh) {
        if (socket && !forceRefresh) return;
        cleanupSocket();
        clearReconnectTimer();

        hideRefreshAction();
        setStatus('Preparing secure connection for this application...', 'info');
        appendSystemMessage('Opening secure chat for application #' + config.applicationId + '...', { key: 'chat-opening' });

        if (!forceRefresh && hasReusableSession()) {
            openSocketConnection(currentSocketUrl);
            return;
        }

        fetchChatToken().then(function(tokenData) {
            sessionToken = tokenData.token;
            currentSocketUrl = tokenData.websocket_url;
            scheduleTokenLifecycle(tokenData);
            openSocketConnection(currentSocketUrl);
        }).catch(function(error) {
            handleInitializationError(error);
        });
    }

    function sendMessage(event) {
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        trackInteraction();
        const message = inputEl.value.trim();
        if (!message || !socket || !isAuthenticated || !operatorAccepted) return;

        socket.emit('send_message', { message: message, message_type: 'text' }, function(response) {
            if (!response || response.success === false) {
                appendSystemMessage((response && response.message) || 'Failed to send message');
                return;
            }
            appendMessage(message, 'sent');
            inputEl.value = '';
            emitUserStopTyping();
        });
    }

    function readAttachmentDataBase64(file) {
        return new Promise(function(resolve) {
            // Keep websocket payload compact; URL upload remains the source of truth.
            if (!file || file.size > (220 * 1024)) {
                resolve('');
                return;
            }
            const reader = new FileReader();
            reader.onload = function() {
                resolve(String(reader.result || ''));
            };
            reader.onerror = function() {
                resolve('');
            };
            reader.readAsDataURL(file);
        });
    }

    function handleFileSelect(event) {
        trackInteraction();
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        event.target.value = '';

        const errorEl = document.getElementById('sgsk-upload-error');
        errorEl.style.display = 'none';

        if (file.size > 5 * 1024 * 1024) {
            errorEl.textContent = 'File too large. Maximum size is 5 MB.';
            errorEl.style.display = 'block';
            return;
        }

        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
        if (allowed.indexOf(file.type) === -1) {
            errorEl.textContent = 'Unsupported file type. Allowed: JPEG, PNG, GIF, WebP, PDF.';
            errorEl.style.display = 'block';
            return;
        }

        uploadAndSendAttachment(file);
    }

    function uploadAndSendAttachment(file) {
        if (!socket || !isAuthenticated || !operatorAccepted) return;

        const sendBtn = document.getElementById('sgsk-chat-send');
        const errorEl = document.getElementById('sgsk-upload-error');
        const originalText = sendBtn.textContent;
        sendBtn.textContent = 'Uploading...';
        sendBtn.disabled = true;

        const formData = new FormData();
        formData.append('file', file);
        formData.append('token', sessionToken || '');
        formData.append('embed_token', config.embedToken || '');

        readAttachmentDataBase64(file).then(function(attachmentDataBase64) {
        const previewDataUrl = /^data:image\//i.test(attachmentDataBase64) ? attachmentDataBase64 : '';
        return fetch(config.apiEndpoint.replace(/\/$/, '') + '/upload_attachment', {
            method: 'POST',
            body: formData
        }).then(function(res) {
            return res.json().then(function(data) {
                if (!res.ok || !data.success) {
                    throw new Error(data.message || 'Upload failed');
                }
                return data.data;
            });
        }).then(function(uploadData) {
            const payload = {
                message: file.name,
                message_type: 'attachment',
                attachment_url: uploadData.url,
                attachment_type: uploadData.type,
                attachment_preview_data: previewDataUrl || '',
                attachment_data_base64: attachmentDataBase64 || ''
            };

            socket.emit('send_message', payload, function(response) {
                if (!response || response.success === false) {
                    errorEl.textContent = (response && response.message) || 'Failed to send attachment';
                    errorEl.style.display = 'block';
                    return;
                }
                appendAttachmentMessage(normalizeInboundFileUrl(uploadData.url), file.name, 'sent', previewDataUrl || '', attachmentDataBase64 || '');
            });
        }).catch(function(err) {
            errorEl.textContent = err.message || 'Failed to upload file';
            errorEl.style.display = 'block';
        }).finally(function() {
            sendBtn.textContent = originalText;
            sendBtn.disabled = false;
        });
        });
    }

    function destroy() {
        clearReconnectTimer();
        clearTokenTimers();
        stopStatusPolling();
        stopWaitingEta();
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
        refreshActionEl = null;
        sessionNoticeEl = null;
        initialized = false;
        isAuthenticated = false;
        operatorAccepted = false;
        unreadCount = 0;
        sessionToken = null;
        currentSocketUrl = null;
        reconnectAttempt = 0;
        historyLoaded = false;
        sessionExpiresAt = null;
    }

    function init(options) {
        const nextConfig = normalizeConfig(options);
        ensureRequiredConfig(nextConfig);
        destroy();
        config = nextConfig;
        createWidget();
        setInputEnabled(false);
        hideSessionNotice();
        hideRefreshAction();
        setStatus('Ready to connect to this application', 'info');
        initialized = true;
        return window.ChatWidget;
    }

    function reinitialize(nextOptions) {
        try {
            const merged = normalizeConfig(nextOptions);
            ensureRequiredConfig(merged);
            init(merged);
            if (chatWindow) {
                chatWindow.style.display = 'flex';
            }
            connect(true);
        } catch (error) {
            handleInitializationError(error);
        }
    }

    function autoInitIfConfigured() {
        const merged = normalizeConfig();
        const modernModeReady = !!(merged.apiKey && merged.applicationIdB64);
        const legacyModeReady = !!(merged.applicationId && merged.embedToken);
        if (!modernModeReady && !legacyModeReady) {
            return;
        }

        try {
            init(merged);
        } catch (error) {
            handleInitializationError(error);
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
            handleInitializationError(createFriendlyError('Unable to load the chat connection library. Please refresh the page.', TOKEN_ERROR_TYPES.network, true));
        };
        document.head.appendChild(script);
    }

    window.ChatWidget = {
        init: init,
        open: open,
        close: close,
        destroy: destroy,
        sendMessage: function(message) {
            trackInteraction();
            if (!message || !socket || !isAuthenticated || !operatorAccepted) {
                return false;
            }
            socket.emit('send_message', { message: String(message), message_type: 'text' }, function(response) {
                if (!response || response.success === false) {
                    appendSystemMessage((response && response.message) || 'Failed to send message');
                    return;
                }
                appendMessage(String(message), 'sent');
                emitUserStopTyping();
            });
            return true;
        },
        setUserData: function(data) {
            const nextConfig = normalizeConfig(Object.assign({}, config || {}, data || {}));
            const mustReconnect = !config
                || String(config.applicationId || '') !== String(nextConfig.applicationId || '')
                || String(config.embedToken || '') !== String(nextConfig.embedToken || '');

            config = nextConfig;

            if (mustReconnect && initialized) {
                reinitialize(nextConfig);
            }
        },
        trackEvent: function(name) {
            if (!name) return false;
            trackInteraction();
            return true;
        },
        getState: function() {
            return {
                initialized: initialized,
                isAuthenticated: isAuthenticated,
                operatorAccepted: operatorAccepted,
                applicationId: config && config.applicationId ? config.applicationId : null,
                applicationIdB64: config && config.applicationIdB64 ? config.applicationIdB64 : null,
                websocketUrl: currentSocketUrl,
                sessionExpiresAt: sessionExpiresAt
            };
        },
        encodeApplicationIdB64: encodeApplicationIdB64,
        decodeApplicationIdB64: decodeApplicationIdB64
    };

    window.SGSKChat = window.ChatWidget;

    window.addEventListener('beforeunload', function() {
        clearReconnectTimer();
        clearTokenTimers();
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
