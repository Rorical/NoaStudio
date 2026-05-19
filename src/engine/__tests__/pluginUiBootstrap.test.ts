import { describe, it, expect } from 'vitest';
import { injectBootstrap, PLUGIN_UI_BOOTSTRAP } from '../pluginUiBootstrap';

describe('injectBootstrap', () => {
  it('inserts the bootstrap right before </head>', () => {
    const html = '<!doctype html><html><head><title>X</title></head><body>hi</body></html>';
    const out = injectBootstrap(html);
    expect(out).toContain('<title>X</title>' + PLUGIN_UI_BOOTSTRAP + '</head>');
    expect(out).toContain('<body>hi</body>');
  });

  it('matches </head> case-insensitively', () => {
    const html = '<HTML><HEAD></HEAD><BODY></BODY></HTML>';
    const out = injectBootstrap(html);
    expect(out).toContain(PLUGIN_UI_BOOTSTRAP + '</HEAD>');
  });

  it('falls back to inserting after <body ...> when there is no </head>', () => {
    const html = '<body class="x">contents</body>';
    const out = injectBootstrap(html);
    expect(out).toContain('<body class="x">' + PLUGIN_UI_BOOTSTRAP);
    expect(out.indexOf(PLUGIN_UI_BOOTSTRAP)).toBeGreaterThan(out.indexOf('<body'));
  });

  it('prepends the bootstrap when neither </head> nor <body> is present', () => {
    const html = '<div>just a fragment</div>';
    const out = injectBootstrap(html);
    expect(out.startsWith(PLUGIN_UI_BOOTSTRAP)).toBe(true);
    expect(out).toContain('<div>just a fragment</div>');
  });

  it('preserves attributes on <body> when injecting after it', () => {
    const html = '<body data-theme="dark" onload="x()">stuff</body>';
    const out = injectBootstrap(html);
    expect(out).toContain('<body data-theme="dark" onload="x()">' + PLUGIN_UI_BOOTSTRAP);
  });

  it('only injects once even when both </head> and <body> are present', () => {
    const html = '<head></head><body></body>';
    const out = injectBootstrap(html);
    // Should appear exactly once. window.__noa is unique to the bootstrap.
    const count = (out.match(/window\.__noa/g) ?? []).length;
    // window.__noa appears multiple times within the bootstrap itself; what we
    // really want is that the bootstrap as a whole was injected exactly once.
    const occurrences = out.split(PLUGIN_UI_BOOTSTRAP).length - 1;
    expect(occurrences).toBe(1);
    // sanity: bootstrap references window.__noa at least once
    expect(count).toBeGreaterThan(0);
  });
});
