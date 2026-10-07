/**
 * Test support for the live-path suites: serves attachment bytes at the transport boundary of the adapters' shared
 * download function, so the real URL checks, auth headers, size limit and body reader all run without a network.
 */
import type { IncomingMessage } from 'http';
import { Readable } from 'stream';

import { setAttachmentDownloadDefaults } from '@chat-adapter/shared';

export interface AttachmentRequest {
  url: string;
  authorization: string | undefined;
}

/** `files` maps a URL to the byte count served there; any other URL answers 404. */
export function serveAttachments(files: Map<string, number>): AttachmentRequest[] {
  const requests: AttachmentRequest[] = [];
  setAttachmentDownloadDefaults({
    transport: async (url, _signal, headers) => {
      requests.push({ url: url.href, authorization: headers?.authorization });
      const size = files.get(url.href);
      const response = Readable.from(size ? [Buffer.alloc(size, 0x5a)] : []) as unknown as IncomingMessage;
      response.statusCode = size === undefined ? 404 : 200;
      response.statusMessage = size === undefined ? 'Not Found' : 'OK';
      response.headers = { 'content-type': 'application/octet-stream', 'content-length': String(size ?? 0) };
      return response;
    },
  });
  return requests;
}
