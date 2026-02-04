const CRLF = '\r\n';
const BASE64_LINE_LENGTH = 76;

function sanitizeHeaderValue(value) {
    return String(value || '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .replace(/[\r\n]+/g, ' ')
        .trim();
}

function sanitizeFilename(filename) {
    const sanitized = String(filename || '')
        .replace(/\.\.\//g, '')
        .replace(/\.\.\\/g, '')
        .replace(/^\/+/, '')
        .replace(/^[A-Za-z]:[\\/]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[<>:"|?*]/g, '_')
        .replace(/[/\\]/g, '_')
        .trim();

    return sanitized || 'message.eml';
}

function normalizeLineEndings(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n/g, CRLF);
}

function base64EncodeBytes(bytes) {
    let binary = '';
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}

function base64EncodeUtf8(text) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);
    return base64EncodeBytes(bytes);
}

function wrapBase64(base64) {
    if (!base64) return '';

    const lines = [];
    for (let i = 0; i < base64.length; i += BASE64_LINE_LENGTH) {
        lines.push(base64.slice(i, i + BASE64_LINE_LENGTH));
    }

    return lines.join(CRLF);
}

function encodeHeaderWord(value) {
    const clean = sanitizeHeaderValue(value);
    if (!clean) return '';

    const hasNonAscii = /[^\x00-\x7f]/.test(clean);
    if (!hasNonAscii) return clean;

    return `=?UTF-8?B?${base64EncodeUtf8(clean)}?=`;
}

function formatAddress(recipient) {
    const address = sanitizeHeaderValue(recipient?.address || '');
    if (!address) return '';

    const rawName = sanitizeHeaderValue(recipient?.name || '');
    if (!rawName || rawName === address) {
        return `<${address}>`;
    }

    const encodedName = /[^\x00-\x7f]/.test(rawName) ? encodeHeaderWord(rawName) : rawName;
    const isEncoded = encodedName.startsWith('=?UTF-8?B?');

    if (isEncoded) {
        return `${encodedName} <${address}>`;
    }

    const needsQuotes = /[",<>@]/.test(encodedName);
    const displayName = needsQuotes ? `"${encodedName.replace(/"/g, '\\"')}"` : encodedName;

    return `${displayName} <${address}>`;
}

function normalizeRecipient(recipient) {
    const address = recipient?.smtpAddress || recipient?.email || recipient?.address || '';
    return {
        name: recipient?.name || address,
        address
    };
}

function formatAddressList(recipients, type) {
    if (!Array.isArray(recipients)) return '';

    const list = recipients
        .filter(recipient => recipient?.recipType === type)
        .map(recipient => formatAddress(normalizeRecipient(recipient)))
        .filter(Boolean);

    return list.join(', ');
}

function getMessageDate(message) {
    const dateValue = message?.messageDeliveryTime || message?.timestamp || null;
    if (!dateValue) return '';

    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return '';

    return date.toUTCString();
}

function makeBoundary(prefix) {
    const random = Math.random().toString(16).slice(2);
    return `${prefix}-${Date.now()}-${random}`;
}

function extractBase64(dataUrl) {
    if (!dataUrl) return '';
    const commaIndex = dataUrl.indexOf(',');
    return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

function buildTextPart(content, contentType) {
    const normalized = normalizeLineEndings(content || '');
    const encoded = wrapBase64(base64EncodeUtf8(normalized));

    return [
        `Content-Type: ${contentType}; charset="utf-8"`,
        'Content-Transfer-Encoding: base64',
        '',
        encoded
    ];
}

function buildAlternativeLines(boundaryAlt, text, html, includeHeader) {
    const lines = [];

    if (includeHeader) {
        lines.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`);
        lines.push('');
    }

    lines.push(`--${boundaryAlt}`);
    lines.push(...buildTextPart(text, 'text/plain'));
    lines.push(`--${boundaryAlt}`);
    lines.push(...buildTextPart(html, 'text/html'));
    lines.push(`--${boundaryAlt}--`);

    return lines;
}

function buildAttachmentPart(attachment) {
    const mimeType = attachment?.attachMimeTag || 'application/octet-stream';
    const fileName = sanitizeFilename(attachment?.fileName || 'attachment');
    const base64Content = extractBase64(attachment?.contentBase64 || '');

    if (!base64Content) return null;

    const lines = [
        `Content-Type: ${mimeType}; name="${fileName}"`,
        'Content-Transfer-Encoding: base64'
    ];

    if (attachment?.contentId) {
        const contentId = sanitizeHeaderValue(attachment.contentId).replace(/[<>]/g, '');
        if (contentId) {
            lines.push(`Content-ID: <${contentId}>`);
        }
    }

    const disposition = attachment?.contentId ? 'inline' : 'attachment';
    lines.push(`Content-Disposition: ${disposition}; filename="${fileName}"`);
    lines.push('');
    lines.push(wrapBase64(base64Content));

    return lines;
}

function buildEmlFromMessage(message) {
    const headers = [];

    const subject = encodeHeaderWord(message?.subject || '');
    if (subject) {
        headers.push(`Subject: ${subject}`);
    }

    const fromAddress = formatAddress({
        name: message?.senderName || '',
        address: message?.senderEmail || ''
    });

    if (fromAddress) {
        headers.push(`From: ${fromAddress}`);
    }

    const toList = formatAddressList(message?.recipients, 'to');
    if (toList) {
        headers.push(`To: ${toList}`);
    }

    const ccList = formatAddressList(message?.recipients, 'cc');
    if (ccList) {
        headers.push(`Cc: ${ccList}`);
    }

    const date = getMessageDate(message);
    if (date) {
        headers.push(`Date: ${date}`);
    }

    headers.push('MIME-Version: 1.0');

    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const bodyText = normalizeLineEndings(message?.bodyContent || '');
    const bodyHtml = normalizeLineEndings(message?.bodyContentHTML || '');

    const hasText = bodyText.trim().length > 0;
    const hasHtml = bodyHtml.trim().length > 0;
    const useBoth = hasText && hasHtml;

    if (attachments.length > 0) {
        const boundaryMixed = makeBoundary('mixed');
        headers.push(`Content-Type: multipart/mixed; boundary="${boundaryMixed}"`);

        const lines = [];

        if (useBoth) {
            const boundaryAlt = makeBoundary('alt');
            lines.push(`--${boundaryMixed}`);
            lines.push(...buildAlternativeLines(boundaryAlt, bodyText, bodyHtml, true));
        } else if (hasHtml || hasText) {
            const partType = hasHtml ? 'text/html' : 'text/plain';
            lines.push(`--${boundaryMixed}`);
            lines.push(...buildTextPart(hasHtml ? bodyHtml : bodyText, partType));
        } else {
            lines.push(`--${boundaryMixed}`);
            lines.push(...buildTextPart('', 'text/plain'));
        }

        attachments.forEach((attachment) => {
            const partLines = buildAttachmentPart(attachment);
            if (!partLines) return;
            lines.push(`--${boundaryMixed}`);
            lines.push(...partLines);
        });

        lines.push(`--${boundaryMixed}--`);

        return headers.join(CRLF) + CRLF + CRLF + lines.join(CRLF);
    }

    if (useBoth) {
        const boundaryAlt = makeBoundary('alt');
        headers.push(`Content-Type: multipart/alternative; boundary="${boundaryAlt}"`);
        const lines = buildAlternativeLines(boundaryAlt, bodyText, bodyHtml, false);
        return headers.join(CRLF) + CRLF + CRLF + lines.join(CRLF);
    }

    if (hasHtml || hasText) {
        const contentType = hasHtml ? 'text/html' : 'text/plain';
        headers.push(`Content-Type: ${contentType}; charset="utf-8"`);
        headers.push('Content-Transfer-Encoding: base64');
        const payload = wrapBase64(base64EncodeUtf8(hasHtml ? bodyHtml : bodyText));
        return headers.join(CRLF) + CRLF + CRLF + payload;
    }

    headers.push('Content-Type: text/plain; charset="utf-8"');
    headers.push('Content-Transfer-Encoding: base64');

    return headers.join(CRLF) + CRLF + CRLF + wrapBase64(base64EncodeUtf8(''));
}

function deriveEmlFileName(message) {
    const original = String(message?.fileName || '').trim();

    if (original) {
        if (/\.eml$/i.test(original)) {
            return sanitizeFilename(original);
        }

        if (/\.msg$/i.test(original)) {
            return sanitizeFilename(original.replace(/\.msg$/i, '.eml'));
        }
    }

    const subject = sanitizeFilename(message?.subject || 'message');
    const base = subject.replace(/\.eml$/i, '').trim() || 'message';

    return `${base}.eml`;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    return base64EncodeBytes(bytes);
}

export function buildEmlDownload(message) {
    if (!message) return null;

    const fileName = deriveEmlFileName(message);

    if (message._fileType === 'eml' && message._rawBuffer) {
        const base64 = arrayBufferToBase64(message._rawBuffer);
        return {
            fileName,
            dataUrl: `data:message/rfc822;base64,${base64}`
        };
    }

    const emlContent = buildEmlFromMessage(message);
    const base64 = base64EncodeUtf8(emlContent);

    return {
        fileName,
        dataUrl: `data:message/rfc822;base64,${base64}`
    };
}
