import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { launch } from 'puppeteer';
import { createServer } from 'vite';

let vite;
let server;
let browser;
let baseUrl;

before(async () => {
    vite = await createServer({
        root: fileURLToPath(new URL('..', import.meta.url)),
        configFile: false,
        server: { middlewareMode: true },
        appType: 'custom',
    });
    server = createHttpServer((request, response) => {
        if (request.url === '/') {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head></head><body></body></html>');
        } else {
            vite.middlewares(request, response);
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await launch({ headless: true });
});

after(async () => {
    await browser?.close();
    await vite?.close();
    if (server) await new Promise(resolve => server.close(resolve));
});

async function createFrame(t, html) {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.goto(baseUrl);
    await page.evaluate(async content => {
        const { buildEmailDocument } = await import('/src/lib/sanitize.ts');
        window.linkMessages = [];
        const frame = document.createElement('iframe');
        frame.sandbox = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
        window.addEventListener('message', event => {
            window.linkMessages.push({
                data: event.data,
                fromFrame: event.source === frame.contentWindow,
                origin: event.origin,
            });
        });
        frame.srcdoc = buildEmailDocument(content, false);
        await new Promise(resolve => {
            frame.addEventListener('load', resolve, { once: true });
            document.body.append(frame);
        });
    }, html);
    const frame = page.frames().find(candidate => candidate !== page.mainFrame());
    return { page, frame };
}

test('HTML email clicks reach the parent from an opaque sandbox without opening a popup', async t => {
    const { page, frame } = await createFrame(
        t,
        '<a href="https://example.com/mail?q=1&amp;x=2"><span>Open link</span></a>',
    );
    let popups = 0;
    page.on('popup', () => popups++);
    await frame.click('a span');
    await page.waitForFunction(() => window.linkMessages.length === 1);
    assert.deepEqual(await page.evaluate(() => window.linkMessages), [
        {
            data: {
                type: 'mail2telegram:open-email-link',
                href: 'https://example.com/mail?q=1&x=2',
            },
            fromFrame: true,
            origin: 'null',
        },
    ]);
    assert.equal(popups, 0);
});

test('Telegram links use the same bridge', async t => {
    const { page, frame } = await createFrame(t, '<a href="https://t.me/example_bot">Bot</a>');
    await frame.click('a');
    await page.waitForFunction(() => window.linkMessages.length === 1);
    assert.equal(await page.evaluate(() => window.linkMessages[0].data.href), 'https://t.me/example_bot');
});

test('email scripts and event handlers are stripped while the bridge still runs', async t => {
    const { page, frame } = await createFrame(
        t,
        `<script>window.parent.postMessage('unsafe', '*')</script>
         <a href="https://example.com" onclick="window.parent.postMessage('unsafe', '*')">Safe link</a>
         <img src="/missing-image" onerror="window.parent.postMessage('unsafe', '*')">
         <a id="unsafe-url" href="javascript:alert(1)">Unsafe URL</a>`,
    );
    assert.equal(await frame.$eval('a', link => link.hasAttribute('onclick')), false);
    assert.equal(await frame.$eval('img', image => image.hasAttribute('onerror')), false);
    assert.equal(await frame.$eval('#unsafe-url', link => link.hasAttribute('href')), false);
    assert.equal(await frame.$$eval('script', scripts => scripts.length), 1);
    await frame.click('a');
    await page.waitForFunction(() => window.linkMessages.length === 1);
    assert.equal(await page.evaluate(() => window.linkMessages[0].data.type), 'mail2telegram:open-email-link');
    assert.equal(
        await frame.evaluate(() => {
            try {
                return Boolean(window.parent.document);
            } catch {
                return false;
            }
        }),
        false,
    );
});

test('fragment navigation stays inside the email', async t => {
    const { page, frame } = await createFrame(t, '<a href="#section">Jump</a><p id="section">Section</p>');
    await frame.click('a');
    await frame.waitForFunction(() => location.hash === '#section');
    assert.deepEqual(await page.evaluate(() => window.linkMessages), []);
});

test('browser fallback opens only HTTP(S) URLs without overriding window.open', async t => {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.goto(baseUrl);
    const calls = await page.evaluate(async () => {
        const opened = [];
        const stub = (...args) => {
            opened.push(args);
            return null;
        };
        window.open = stub;
        const { openExternal } = await import('/src/init.ts');
        openExternal('javascript:alert(1)');
        openExternal('data:text/html,unsafe');
        openExternal('not a URL');
        openExternal('https://example.com/');
        if (window.open !== stub) throw new Error('window.open was overridden');
        return opened;
    });
    assert.deepEqual(calls, [['https://example.com/', '_blank', 'noopener,noreferrer']]);
});
