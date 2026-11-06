// Pure helpers for the receiver worker: which camera reads go to the
// collector, and what a version 4 read says about its packets.
// Probe and characterization frames measure the light path and never reach
// the collector. No DOM.

import { FRAME_TYPES } from '../core/frame.js';

/** Only data frames (and version 2 frames, which have no type) are collected. */
export const isDataHeader = (h) => !h || h.frameType === FRAME_TYPES.data;

/** A string of '0'/'1', one per packet of a version 4 frame; null for any other read. */
export function packetMaskOf(frame) {
  if (!frame?.packets) return null;
  return frame.packets.map((p) => (p ? '1' : '0')).join('');
}

/** Routes one decoded read to the collector; returns whether it was a data frame. */
export function routeRead(collector, { read, frame }) {
  const isData = isDataHeader(read.frameHeader ?? null);
  if (frame && isData) collector.add(frame);
  else if (!frame && isData && read.markersFound && read.blocks) collector.noteFailure();
  return isData;
}

/** The finder pass the next camera attempt should try first: the one that just
 * produced a frame, unless that was the standard pass, which runs first anyway.
 * A failed attempt clears it, and so does a version 4 frame with no good packet. */
export function nextFinderHint(read, frame) {
  if (!frame) return null;
  if (frame.packets && !frame.packets.some(Boolean)) return null;
  return read.finderPass === 'perspective' || read.finderPass === 'recovery' ? read.finderPass : null;
}

/** The header fields of a worker attempt. */
export function attemptHeader(h, frame) {
  if (!h) return null;
  const mask = h.version === 4 ? packetMaskOf(frame) : null;
  return {
    version: h.version, frameType: h.frameType, probeId: h.probeId, probeCount: h.probeCount,
    scheme: h.scheme, blockSize: h.blockSize, parity: h.parity,
    txId: h.txId, index: h.index, probeFps: h.probeFps, probeStatic: h.probeStatic,
    ...(h.version === 4 ? {
      sourceCount: h.sourceCount,
      goodPackets: frame ? frame.packets.filter(Boolean).length : 0,
      ...(frame ? { symbolIds: frame.packets.filter(Boolean).map((q) => q.symbolId) } : {}),
      ...(mask ? { packetCount: mask.length, packetMask: mask } : {}),
    } : {}),
  };
}
