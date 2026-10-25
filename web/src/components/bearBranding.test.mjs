import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { parse } from "@vue/compiler-sfc";
import { compile } from "@vue/compiler-dom";
import * as Vue from "vue";
import { renderToString } from "vue/server-renderer";

const webRoot = new URL("../../", import.meta.url);
const source = readFileSync(new URL("src/components/BearLogo.vue", webRoot), "utf8");
const { descriptor } = parse(source);
const { code } = compile(descriptor.template.content, { mode: "function", prefixIdentifiers: true });
const render = new Function("Vue", code)(Vue);
const Logo = { render: () => render({}, []) };
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function asset(path) {
  return readFileSync(new URL(`public${path}`, webRoot));
}
function assertPngSize(data, size) {
  assert.deepEqual(data.subarray(0, 8), pngSignature);
  assert.equal(data.readUInt32BE(16), size);
  assert.equal(data.readUInt32BE(20), size);
}
function assertTransparentPng(data, size) {
  assertPngSize(data, size);
  assert.equal(data[24], 8, "8-bit channels");
  assert.equal(data[25], 6, "RGBA artwork");
  assert.equal(data[28], 0, "non-interlaced PNG");
  const chunks = [];
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset);
    if (data.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(data.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  // The first pixel has no left or previous-row neighbors under any PNG filter.
  assert.equal(inflateSync(Buffer.concat(chunks))[4], 0, "the exterior corner is truly transparent");
}

test("shared logo renders the approved transparent artwork with accessible name and uncropped sizing", async () => {
  const html = await renderToString(Vue.createSSRApp(Logo));
  assert.match(html, /<img\b/);
  assert.match(html, /alt="OpenBear"/);
  assert.match(html, /draggable="false"/);
  const src = html.match(/src="([^"]+)"/)[1];
  assert.match(src, /^\/assets\/brand\/openbear-[a-f0-9]{12}\.png$/);
  assertTransparentPng(asset(src), 512);
  assert.deepEqual(asset(src), asset("/icons/openbear-512.png"), "UI and installed-app icons use the same approved artwork");
  assert.match(descriptor.styles[0].content, /border-radius:\s*22%/);
  assert.match(descriptor.styles[0].content, /object-fit:\s*contain/);
  assert.doesNotMatch(source, /<svg|🐻/);
});

test("light and dark UI share the same transparent artwork", async () => {
  for (const theme of ["light", "dark"]) {
    const html = await renderToString(Vue.createSSRApp({
      render: () => Vue.h("div", { class: theme }, [Vue.h(Logo)]),
    }));
    const src = html.match(/src="([^"]+)"/)[1];
    assert.equal(src, "/assets/brand/openbear-8b4a77935326.png");
    assertTransparentPng(asset(src), 512);
  }
});

test("brand containers retain their layout without decorative frames", () => {
  const login = readFileSync(new URL("src/views/LoginView.vue", webRoot), "utf8");
  assert.match(login, /<div class="mx-auto w-14 h-14 flex items-center justify-center"><BearLogo \/><\/div>/);
  assert.match(login, /login-screen min-h-screen flex items-center justify-center bg-macbg/);
  const app = readFileSync(new URL("src/App.vue", webRoot), "utf8");
  const mobile = app.match(/\.mobile-brand-logo\s*\{([^}]+)\}/)[1];
  assert.match(mobile, /width:\s*25px/);
  assert.match(mobile, /height:\s*25px/);
  assert.match(mobile, /padding:\s*4px/);
  assert.match(mobile, /background:\s*transparent/);
  assert.doesNotMatch(mobile, /box-shadow|border:/);
});

test("PWA and Apple icons retain their sizes and existing application identity with transparent exteriors", () => {
  for (const [path, size] of [["/icons/openbear-192.png", 192], ["/icons/openbear-512.png", 512], ["/icons/apple-touch-icon.png", 180]]) {
    assertTransparentPng(asset(path), size);
  }
  const manifest = JSON.parse(asset("/manifest.webmanifest"));
  assert.deepEqual([manifest.id, manifest.start_url, manifest.scope], ["./", "./", "./"]);
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes).sort(), ["192x192", "512x512"]);
});

test("favicon links use versioned assets and provide real small-size ICO frames", () => {
  const html = readFileSync(new URL("index.html", webRoot), "utf8");
  const paths = [...html.matchAll(/<link\b[^>]*rel="icon"[^>]*href="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(paths.length, 2);
  const icoPath = paths.find((path) => path.endsWith(".ico"));
  const pngPath = paths.find((path) => path.endsWith(".png"));
  assert.match(icoPath, /^\/assets\/brand\/favicon-[a-f0-9]{12}\.ico$/);
  assertPngSize(asset(pngPath), 32);
  const ico = asset(icoPath);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const size = ico[entry] || 256;
    assert.equal(ico[entry + 1] || 256, size);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset >= 6 + count * 16 && offset + length <= ico.length);
    assertPngSize(ico.subarray(offset, offset + length), size);
    sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 32, 48, 64]);
});
