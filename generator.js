/**
 * Blink Paywall generator page.
 *
 * Everything is client-side: validate the username against Blink's public
 * API, build the embed snippet from the form, and keep a live preview
 * mounted with the locally served widget bundle.
 */
(function () {
    'use strict';

    // Published widget URL. paywall.blink.sv is reserved but not wired up yet;
    // switch this (and the README) over once the DNS record + CNAME land.
    var SCRIPT_URL = 'https://blinkbitcoin.github.io/blink-paywall/v1/blink-paywall.js';
    var API_URL = 'https://api.blink.sv/graphql';

    var $ = function (id) {
        return document.getElementById(id);
    };

    var state = { usernameOk: false, previewInstance: null };

    // ── Username validation (custodial via usernameAvailable, Spark via LNURL probe) ──

    function cleanUsername(value) {
        return String(value || '')
            .trim()
            .replace(/^@/, '')
            .replace(/@.*$/, '')
            .toLowerCase();
    }

    async function usernameExists(username) {
        try {
            var response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: 'query Check($username: Username!) { usernameAvailable(username: $username) }',
                    variables: { username: username },
                }),
            });
            var data = await response.json();
            if (data.errors) {
                if (String(data.errors[0].message).indexOf('Invalid value') !== -1) {
                    return { exists: false, invalid: true };
                }
                return { exists: true }; // fail open on unrelated errors
            }
            if (data.data.usernameAvailable === false) return { exists: true };
        } catch {
            return { exists: true }; // fail open: never block generation on network issues
        }
        // Not a custodial user — probe the LNURL endpoint for a Spark user.
        try {
            var lnurl = await fetch(
                'https://blink.sv/.well-known/lnurlp/' + encodeURIComponent(username),
                {
                    headers: { Accept: 'application/json' },
                }
            );
            if (!lnurl.ok) return { exists: false };
            var meta = await lnurl.json();
            return { exists: meta && meta.tag === 'payRequest' && Boolean(meta.callback) };
        } catch {
            return { exists: true };
        }
    }

    async function checkUsername() {
        var username = cleanUsername($('username').value);
        $('username').value = username;
        var status = $('username-status');
        state.usernameOk = false;
        if (!username) {
            status.className = 'error';
            status.textContent = 'Enter your Blink username.';
            return;
        }
        status.className = 'hint';
        status.textContent = 'Checking\u2026';
        var result = await usernameExists(username);
        if (result.invalid) {
            status.className = 'error';
            status.textContent = 'Usernames use letters, numbers and underscores only.';
        } else if (!result.exists) {
            status.className = 'error';
            status.innerHTML =
                'No Blink account with that username. <a href="https://get.blink.sv?referral=blink_paywall" target="_blank" rel="noopener">Download Blink</a> to create one.';
        } else {
            state.usernameOk = true;
            status.className = 'success';
            status.textContent = '\u2713 Username found';
        }
        update();
    }

    // ── Snippet building ──

    function escapeAttr(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function escapeText(value) {
        return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function slugify(value) {
        return (
            String(value || '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 40) || 'item-1'
        );
    }

    function unlockType() {
        return document.querySelector('input[name="unlock-type"]:checked').value;
    }

    // ── URL state ──
    //
    // The whole form lives in the hash fragment, so a bookmarked link restores
    // the setup (and can be shared). The fragment — not a query string — keeps
    // it out of server logs and Referer headers: one unlock type is a secret
    // (licence key, coupon, password).
    //
    // Each entry maps a URL key to the field it round-trips and the default
    // that keeps it OUT of the URL, so a simple setup stays short.

    var URL_FIELDS = [
        { key: 'type', id: null, def: 'content' }, // radio group, handled below
        { key: 'username', id: 'username', def: '' },
        { key: 'amount', id: 'amount', def: '1000' },
        { key: 'currency', id: 'currency', def: 'sats' },
        { key: 'title', id: 'title', def: 'Unlock the full article' },
        { key: 'description', id: 'description', def: '' },
        { key: 'remember', id: 'remember', def: 'forever' },
        { key: 'theme', id: 'theme', def: 'auto' },
        { key: 'id', id: 'item-id', def: '' },
        { key: 'unlockClass', id: 'unlock-class', def: '' },
        { key: 'webhook', id: 'webhook', def: '' },
        { key: 'content', id: 'content-html', def: '' },
        { key: 'secret', id: 'secret-text', def: '' },
        { key: 'embed', id: 'embed-url', def: '' },
        { key: 'redirect', id: 'redirect-url', def: '' },
        { key: 'l402', id: 'l402-url', def: '' },
    ];

    var UNLOCK_TYPES = ['content', 'secret', 'embed', 'redirect', 'l402'];

    // Long locked content makes long links. Browsers cope; chat and mail clients
    // truncate. Warn rather than silently hand over a broken link.
    var URL_LENGTH_WARN = 2000;

    function buildHash() {
        var params = new URLSearchParams();
        URL_FIELDS.forEach(function (field) {
            var value = field.id ? $(field.id).value : unlockType();
            if (value !== field.def) params.set(field.key, value);
        });
        return params.toString();
    }

    function applyHash(hash) {
        var params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
        if (!Array.from(params.keys()).length) return false;

        URL_FIELDS.forEach(function (field) {
            if (!params.has(field.key)) return;
            var value = params.get(field.key);
            if (field.id) {
                $(field.id).value = value;
                return;
            }
            // Unlock type: only accept a known value, else leave the default.
            if (UNLOCK_TYPES.indexOf(value) === -1) return;
            var radio = document.querySelector('input[name="unlock-type"][value="' + value + '"]');
            if (radio) radio.checked = true;
        });
        return true;
    }

    function syncHash() {
        var hash = buildHash();
        var url = window.location.pathname + window.location.search + (hash ? '#' + hash : '');
        try {
            // replaceState, not pushState: typing must not fill the back button.
            window.history.replaceState(null, '', url);
        } catch {
            // Some sandboxed contexts (file://, srcdoc iframes) reject this.
            return;
        }
        var tooLong = window.location.href.length > URL_LENGTH_WARN;
        $('link-warning').hidden = !tooLong;
    }

    function readForm() {
        var type = unlockType();
        return {
            type: type,
            username: cleanUsername($('username').value),
            amount: $('amount').value,
            currency: $('currency').value,
            title: $('title').value.trim(),
            description: $('description').value.trim(),
            remember: $('remember').value,
            theme: $('theme').value,
            id: $('item-id').value.trim() || slugify($('title').value),
            unlockClass: $('unlock-class').value.trim(),
            webhook: $('webhook').value.trim(),
            contentHtml: $('content-html').value,
            secretText: $('secret-text').value,
            embedUrl: $('embed-url').value.trim(),
            redirectUrl: $('redirect-url').value.trim(),
            l402Url: $('l402-url').value.trim(),
        };
    }

    function buildAttributes(config) {
        var attributes = [['data-blink-paywall', null]];
        if (config.type === 'l402') {
            attributes.push([
                'data-l402',
                config.l402Url || 'https://your-server.com/content/' + config.id,
            ]);
        } else {
            attributes.push(['data-username', config.username || 'YOUR_BLINK_USERNAME']);
            attributes.push(['data-amount', config.amount || '1000']);
            attributes.push(['data-currency', config.currency]);
        }
        attributes.push(['data-id', config.id]);
        if (config.title) attributes.push(['data-title', config.title]);
        if (config.description) attributes.push(['data-description', config.description]);
        if (config.remember !== 'forever') attributes.push(['data-remember', config.remember]);
        if (config.theme !== 'auto') attributes.push(['data-theme', config.theme]);
        if (config.type === 'redirect' && config.redirectUrl) {
            attributes.push(['data-redirect', config.redirectUrl]);
        }
        if (config.unlockClass) attributes.push(['data-unlock-class', config.unlockClass]);
        if (config.webhook) attributes.push(['data-webhook', config.webhook]);
        return attributes;
    }

    function templateInner(config) {
        if (config.type === 'content') {
            return config.contentHtml.trim() || '<p>Your locked content here.</p>';
        }
        if (config.type === 'secret') {
            return (
                '<p>Your secret:</p>\n    <pre style="font-size:1.2em; user-select: all">' +
                escapeText(config.secretText || 'SECRET-CODE') +
                '</pre>'
            );
        }
        if (config.type === 'embed') {
            return (
                '<iframe src="' +
                escapeAttr(config.embedUrl || 'https://www.youtube-nocookie.com/embed/VIDEO_ID') +
                '" style="width:100%; aspect-ratio:16/9; border:0" allowfullscreen></iframe>'
            );
        }
        return null; // redirect + l402 have no template
    }

    function buildSnippet(config) {
        var lines = [
            '<!-- Blink Paywall -->',
            '<script defer src="' + SCRIPT_URL + '"></' + 'script>',
        ];
        var attributes = buildAttributes(config)
            .map(function (pair) {
                return pair[1] === null ? pair[0] : pair[0] + '="' + escapeAttr(pair[1]) + '"';
            })
            .join('\n     ');
        var inner = templateInner(config);
        if (inner) {
            lines.push('<div ' + attributes + '>');
            lines.push('  <template>');
            lines.push('    ' + inner);
            lines.push('  </template>');
            lines.push('</div>');
        } else {
            lines.push('<div ' + attributes + '></div>');
        }
        return lines.join('\n');
    }

    // ── Live preview ──

    function renderPreview(config) {
        if (!window.BlinkPaywall) return;
        if (state.previewInstance) state.previewInstance.destroy();
        var host = $('preview');
        host.innerHTML = '';

        var el = document.createElement('div');
        buildAttributes(config).forEach(function (pair) {
            el.setAttribute(pair[0], pair[1] === null ? '' : pair[1]);
        });
        var inner = templateInner(config);
        if (inner) {
            var template = document.createElement('template');
            template.innerHTML = inner;
            el.appendChild(template);
        }
        host.appendChild(el);
        // Preview must not really navigate away.
        var overrides =
            config.type === 'redirect'
                ? { redirect: undefined, onUnlock: previewRedirectNote(config) }
                : {};
        state.previewInstance = window.BlinkPaywall.mount(el, overrides);
    }

    function previewRedirectNote(config) {
        return function () {
            var note = document.createElement('p');
            note.className = 'hint';
            note.textContent =
                'Preview: the real snippet now redirects to ' + (config.redirectUrl || 'your URL');
            $('preview').appendChild(note);
        };
    }

    var hashTimer = null;

    function update() {
        var config = readForm();
        $('code').textContent = buildSnippet(config);
        clearTimeout(hashTimer);
        hashTimer = setTimeout(syncHash, 300);
        $('price-step').style.display = config.type === 'l402' ? 'none' : '';
        $('hard-mode-note').style.display = config.type === 'l402' ? 'block' : 'none';
        ['content', 'secret', 'embed', 'redirect', 'l402'].forEach(function (name) {
            $('field-' + name).hidden = name !== config.type;
        });
        document.querySelectorAll('.type-card').forEach(function (card) {
            card.classList.toggle('selected', card.querySelector('input').checked);
        });
        renderPreview(config);
    }

    // ── Wiring ──

    $('check-username').addEventListener('click', checkUsername);
    $('username').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') checkUsername();
    });

    document.querySelectorAll('input, select, textarea').forEach(function (input) {
        if (input.id === 'username') return;
        input.addEventListener('input', update);
        input.addEventListener('change', update);
    });

    $('copy').addEventListener('click', function () {
        navigator.clipboard.writeText($('code').textContent).then(function () {
            $('copy').textContent = '\u2713 Copied';
            setTimeout(function () {
                $('copy').textContent = 'Copy code';
            }, 1500);
        });
    });

    $('copy-link').addEventListener('click', function () {
        syncHash(); // flush any pending debounce so the link is current
        navigator.clipboard.writeText(window.location.href).then(function () {
            $('copy-link').textContent = '\u2713 Link copied';
            setTimeout(function () {
                $('copy-link').textContent = 'Copy link to this setup';
            }, 1500);
        });
    });

    $('reset-preview').addEventListener('click', function () {
        Object.keys(localStorage)
            .filter(function (key) {
                return key.indexOf('blink-paywall:') === 0;
            })
            .forEach(function (key) {
                localStorage.removeItem(key);
            });
        update();
    });

    // Restore a saved setup before the first render. A username in the link is
    // validated as if it had been typed, so the preview mounts ready to pay.
    var restored = applyHash(window.location.hash);
    update();
    if (restored && $('username').value) checkUsername();
})();
