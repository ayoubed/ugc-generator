import { describe, expect, it } from 'vitest';
import { autoCut, buildTimeline, clock, fitScale, locate, rulerMarks, timelineTime, zoomScale } from './timeline';

const timeline = buildTimeline([{ id: 'a', start: 0.5, end: 4 }, { id: 'b', start: 0, end: 2 }, { id: 'c', start: 1, end: 3 }], 2.5);

describe('timeline layout', () => {
  it('puts the kept parts one after another, with the end card after them', () => {
    expect(timeline.clips.map((c) => [c.id, c.at, c.length])).toEqual([['a', 0, 3.5], ['b', 3.5, 2], ['c', 5.5, 2]]);
    expect(timeline.clipsEnd).toBe(7.5);
    expect(timeline.total).toBe(10);
  });

  it('finds the clip and the place inside its file for a moment', () => {
    expect(locate(timeline, 0)).toEqual({ index: 0, clipTime: 0.5 });
    expect(locate(timeline, 3.4).index).toBe(0);
    expect(locate(timeline, 3.5)).toEqual({ index: 1, clipTime: 0 });
    expect(locate(timeline, 6)).toEqual({ index: 2, clipTime: 1.5 });
  });

  it('stays on the last clip past the end, and on the first before the start', () => {
    expect(locate(timeline, 99).index).toBe(2);
    expect(locate(timeline, -5)).toEqual({ index: 0, clipTime: 0.5 });
    expect(locate(buildTimeline([]), 1)).toBeNull();
  });

  it('turns a place in a clip back into a moment', () => {
    expect(timelineTime(timeline, 1, 1.2)).toBeCloseTo(4.7);
    expect(timelineTime(timeline, 0, 0)).toBe(0);        // before the kept part: its start
    expect(timelineTime(timeline, 0, 99)).toBe(3.5);     // after it: its end
    expect(timelineTime(timeline, 9, 1)).toBe(0);
  });
});

describe('ruler and zoom', () => {
  it('spaces the marks so labels do not crowd', () => {
    expect(rulerMarks(10, 60).map((m) => m.label)).toEqual(['0:00', '0:01', '0:02', '0:03', '0:04', '0:05', '0:06', '0:07', '0:08', '0:09', '0:10']);
    expect(rulerMarks(45, 20).map((m) => m.time)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45]);
    expect(rulerMarks(2, 160).map((m) => m.label)).toEqual(['0:00.0', '0:00.5', '0:01.0', '0:01.5', '0:02.0']);
  });

  it('writes times like a player does', () => {
    expect(clock(7)).toBe('0:07');
    expect(clock(75.26, true)).toBe('1:15.2');
    expect(clock(-3)).toBe('0:00');
  });

  it('fits the video to the width, within limits', () => {
    expect(fitScale(900, 15)).toBe(60);
    expect(fitScale(900, 2)).toBe(200);
    expect(fitScale(900, 120)).toBe(20);
    expect(fitScale(0, 15)).toBe(60);
  });

  it('zooms in and out within limits', () => {
    expect(zoomScale(60, 1)).toBe(84);
    expect(zoomScale(60, -1)).toBe(43);
    expect(zoomScale(200, 1)).toBe(200);
    expect(zoomScale(20, -1)).toBe(20);
  });
});

describe('the automatic cut of a scene', () => {
  const scene = { id: '0', activeAttempt: 2 };
  const project = (version) => ({ finalVideos: [{ version: 1, storageRef: 'v1.mp4', ...version }], finalVideoVersion: 1 });

  it('is what the last stitch kept of the take in use', () => {
    expect(autoCut(project({ cuts: { 0: { start: 0.4, end: 4.6, length: 5, attempt: 2 } } }), scene)).toEqual({ start: 0.4, end: 4.6 });
  });

  it('is unknown before a stitch, or after another take was put in use', () => {
    expect(autoCut({}, scene)).toBeNull();
    expect(autoCut(project({ cuts: { 0: { start: 0.4, end: 4.6, attempt: 1 } } }), scene)).toBeNull();
    expect(autoCut(project({}), scene)).toBeNull();
  });

  it('leaves out a side that came from an edit, not from the automatic cut', () => {
    const version = { cuts: { 0: { start: 1.5, end: 4.6, attempt: 2 } }, edits: { 0: { start: 1.5, attempt: 2 } } };
    expect(autoCut(project(version), scene)).toEqual({ end: 4.6 });
    const both = { cuts: { 0: { start: 1.5, end: 3, attempt: 2 } }, edits: { 0: { start: 1.5, end: 3 } } };
    expect(autoCut(project(both), scene)).toBeNull();
  });
});
