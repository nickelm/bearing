/**
 * Shows the app's software-adapter notice (src/render/common/webgpuSupport.ts) without
 * WebGPU, to read its text and style: `notice.html`. "Start anyway" hides it, adds `software`
 * to the URL and sets the title to "started", as the app would go on to start.
 */
import '../../src/style.css';
import {
  showSoftwareAdapterNotice,
  softwareAdapterNotice,
} from '../../src/render/common/webgpuSupport';

async function main(): Promise<void> {
  const adapter = { info: { isFallbackAdapter: true } };
  if (softwareAdapterNotice(adapter, new URLSearchParams(location.search))) {
    document.title = 'notice';
    await showSoftwareAdapterNotice('google swiftshader (software fallback)');
  }
  document.title = 'started';
}

void main();
