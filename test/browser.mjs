import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createApp, loadConfig } from '../server.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
mkdirSync(new URL('../test-results/', import.meta.url), { recursive: true });
const config = loadConfig({ PLEX_SERVER_ID: 'test-server-id', QBIT_URL: 'http://localhost:8080', QBIT_USERNAME: 'test', QBIT_PASSWORD: 'test', PUBLIC_ORIGIN: 'http://localhost:5080', COOKIE_SECURE: 'false' });
const sample = (name, progress, state, extra = {}) => ({name,progress,state,category:'films',size:8589934592,downloaded:Math.round(8589934592*progress),downloadSpeed:0,uploadSpeed:0,eta:null,seedsConnected:0,seedsTotal:42,peersConnected:0,peersTotal:17,ratio:0,...extra});
let fail = false;
const server = createApp(config, { getSnapshot: async () => {
  if (fail) throw new Error('offline');
  return {updatedAt:new Date().toISOString(),torrents:[
    sample('Big Buck Bunny (2008) · 2160p',.726,'downloading',{downloadSpeed:12582912,uploadSpeed:849346,eta:186,seedsConnected:14,peersConnected:5}),
    sample('Sintel (2010) · BluRay 1080p',.413,'downloading',{downloadSpeed:6501171,uploadSpeed:125829,eta:860,seedsConnected:8,seedsTotal:23,peersConnected:3}),
    sample('Tears of Steel (2012) · 1080p',.128,'stalledDL',{seedsConnected:0,seedsTotal:2,peersTotal:0}),
    sample('Ubuntu Desktop · image ISO',0,'queuedDL',{category:'linux',seedsTotal:null,peersTotal:null}),
    sample('Cosmos Laundromat · 1080p',1,'uploading',{uploadSpeed:524288,seedsConnected:0,peersConnected:9}),
    sample('<img src=x onerror="window.INJECTED=true">',1,'stalledUP')
  ]};
} }, {
 createPin: async () => ({id:123,code:'strongtestpincode',clientId:'browser-test',expires:Date.now()+300000}),
 checkPin: async () => 'private-plex-test-token',
 verifyAccess: async () => ({name:'Test friend'}),
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
config.origin='http://127.0.0.1:'+server.address().port;
let browser;
try {
 browser = await chromium.launch({headless:true});
 const context = await browser.newContext({viewport:{width:1440,height:1050}});
 const page = await context.newPage();
 const errors=[]; page.on('pageerror', e=>errors.push(String(e)));
 await page.goto(config.origin);
 await page.locator('#login-panel').waitFor({state:'visible'});
 await page.screenshot({path:new URL('../test-results/login.png', import.meta.url).pathname,fullPage:true});
 await page.route('https://app.plex.tv/auth', async route => {
   await route.fulfill({contentType:'text/html',body:`<!doctype html><a href="${config.origin}/?plex=return">Finish Plex login</a>`});
 });
 await page.locator('#login-button').click();
 await page.getByText('Finish Plex login').click();
 await page.locator('#torrent-list tr').first().waitFor();
 assert.equal(await page.locator('#torrent-list tr').count(),4);
 await page.screenshot({path:new URL('../test-results/desktop.png', import.meta.url).pathname,fullPage:true});
 await page.locator('[data-filter="all"]').click();
 assert.equal(await page.locator('#torrent-list tr').count(),6);
 assert.equal(await page.locator('#torrent-list img').count(),0);
 assert.equal(await page.evaluate(()=>window.INJECTED),undefined);
 await page.locator('#search').fill('sintel');
 assert.equal(await page.locator('#torrent-list tr').count(),1);
 await page.locator('#search').fill('zzzz-no-results');
 assert.equal(await page.locator('#empty').isVisible(),true);
 await page.locator('#search').fill('');
 await page.locator('[data-filter="pending"]').click();
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:new URL('../test-results/mobile.png', import.meta.url).pathname,fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile should not overflow');
 fail=true; await page.locator('#refresh').click();
 await page.locator('#error-banner').waitFor({state:'visible'});
 assert.equal(await page.locator('#torrent-list tr').count(),4,'last data retained on outage');
 assert.match(await page.locator('#connection').textContent(),/Hors ligne/);
 await page.locator('#logout').click();
 await page.locator('#login-panel').waitFor({state:'visible'});
 assert.equal(await page.locator('#torrent-list tr').count(),0);
 assert.deepEqual(errors,[]);
 console.log('Browser checks passed: login, 1440px desktop, 390px mobile, filters, search, empty state, XSS text escaping, offline data freshness, logout.');
} finally { await browser?.close(); await new Promise(r=>{server.close(r);server.closeAllConnections()}); }
