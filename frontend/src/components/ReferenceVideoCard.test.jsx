import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReferenceVideoCard from './ReferenceVideoCard';
import { updateProjectSettings } from '../hooks/useProject';
import { analyseReference } from '../services/api';

vi.mock('../hooks/useProject', () => ({ updateProjectSettings: vi.fn(async () => {}) }));
vi.mock('../services/api', () => ({ analyseReference: vi.fn(async () => ({})) }));
vi.mock('firebase/storage', () => ({
  ref: vi.fn((_storage, path) => ({ path })),
  uploadBytes: vi.fn(async () => {}),
  getDownloadURL: vi.fn(async () => 'https://files.test/ref.mp4'),
}));

const BREAKDOWN = {
  summary: 'A creator shows a mug that keeps coffee hot.',
  hook: 'Holds the mug up to the camera.',
  scenes: [
    { start: 0, end: 4, purpose: 'Hook', happens: 'Holds up the product.', framing: 'Close selfie', said: 'Their exact words.' },
    { start: 4, end: 8, purpose: 'Proof', happens: 'Shows it in use.', framing: 'Over the shoulder', said: '' },
  ],
  call_to_action: 'Points at the link.',
};
const video = { storageRef: 'users/u1/projects/p1/reference/video_1.mp4', url: 'https://files.test/ref.mp4', name: 'ad.mp4' };
const project = (reference, extra = {}) => ({ id: 'p1', settings: { reference }, ...extra });
const analysing = () => project({ ...video, breakdown: null, use: false }, { referenceStatus: 'analysing', referenceStartedAt: Date.now() });
const ready = (use) => project({ ...video, breakdown: BREAKDOWN, use }, { referenceStatus: 'ready' });

function show(initial, props = {}) {
  const onApply = vi.fn();
  const onBreakdownChange = vi.fn();
  const element = (value) => (
    <ReferenceVideoCard
      project={value}
      storagePrefix="users/u1/projects/p1"
      onApply={onApply}
      onBreakdownChange={onBreakdownChange}
      {...props}
    />
  );
  const view = render(element(initial));
  return { onApply, onBreakdownChange, update: (value) => view.rerender(element(value)) };
}

beforeEach(() => vi.clearAllMocks());

describe('Reference video: before a video is added', () => {
  it('explains the shortcut and what is never reused', () => {
    show(project(null));
    expect(screen.getByRole('heading', { name: 'Start from an ad that already works' })).toBeTruthy();
    expect(screen.getByText(/their\s+words and footage never are/)).toBeTruthy();
    const steps = within(screen.getByRole('list', { name: 'How it works' }));
    expect(steps.getAllByRole('listitem').map((li) => li.textContent.replace(/^\d/, '').split(/(?<=[a-z])(?=[A-Z])/)[0]))
      .toEqual(['Upload their ad', 'See why it works', 'Get your version']);
    expect(screen.getByText(/MP4, MOV or WebM, up to 50 MB/)).toBeTruthy();
  });

  it('uploads the chosen video and starts the breakdown', async () => {
    show(project(null));
    const file = new File(['x'], 'ad.mp4', { type: 'video/mp4' });
    await userEvent.upload(document.querySelector('input[type=file]'), file);
    await waitFor(() => expect(analyseReference).toHaveBeenCalled());
    const [pid, saved] = updateProjectSettings.mock.calls[0];
    expect(pid).toBe('p1');
    expect(saved.reference).toMatchObject({ name: 'ad.mp4', breakdown: null, use: false });
    expect(saved.reference.storageRef).toMatch(/^users\/u1\/projects\/p1\/reference\/video_\d+\.mp4$/);
    expect(analyseReference).toHaveBeenCalledWith('p1', saved.reference.storageRef, 'ad.mp4');
  });

  it('refuses a file that is not a video, or is too large', async () => {
    show(project(null));
    const input = document.querySelector('input[type=file]');
    await userEvent.upload(input, new File(['x'], 'notes.pdf', { type: 'application/pdf' }), { applyAccept: false });
    expect(screen.getByRole('alert').textContent).toBe('Use an MP4, MOV or WebM video.');
    const big = new File(['x'], 'long.mp4', { type: 'video/mp4' });
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    await userEvent.upload(input, big);
    expect(screen.getByRole('alert').textContent).toMatch(/over 50 MB/);
    expect(analyseReference).not.toHaveBeenCalled();
  });
});

describe('Reference video: when the breakdown arrives', () => {
  it('fills in the form and follows the video without being asked', async () => {
    const { onApply, update } = show(analysing());
    expect(screen.getByText(/filled in for you when it is done/)).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();

    update(ready(false));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', { 'reference.use': true });
  });

  it('does not switch it back on for a breakdown that was already there', () => {
    const { onApply } = show(ready(false));
    expect(onApply).not.toHaveBeenCalled();
    expect(updateProjectSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'The breakdown is ready' })).toBeTruthy();
  });

  it('lets you follow it by hand', async () => {
    const { onApply } = show(ready(false));
    await userEvent.click(screen.getByRole('button', { name: 'Use this structure' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', { 'reference.use': true });
  });
});

describe('Reference video: while the script follows it', () => {
  it('says what was filled in and what is still yours to add', () => {
    show(ready(true), { filled: ['2 scenes', '4 seconds each', '3 style details'] });
    expect(screen.getByRole('heading', { name: 'Your script follows this video’s 2 parts' })).toBeTruthy();
    expect(screen.getByText('A creator shows a mug that keeps coffee hot.')).toBeTruthy();
    const filled = within(screen.getByRole('list', { name: 'Filled in from the video' }));
    expect(filled.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['2 scenes', '4 seconds each', '3 style details']);
    expect(screen.getByText('Still yours to add: your idea, the person and your product.')).toBeTruthy();
  });

  it('can stop following it', async () => {
    show(ready(true));
    await userEvent.click(screen.getByRole('button', { name: 'Stop following it' }));
    expect(updateProjectSettings).toHaveBeenCalledWith('p1', { 'reference.use': false });
  });

  it('keeps the breakdown folded until asked, and reports edits', async () => {
    const { onBreakdownChange } = show(ready(true));
    const review = screen.getByText('Review the breakdown · 2 parts').closest('details');
    expect(review.open).toBe(false);
    expect(within(review).getByText('They say: “Their exact words.”')).toBeTruthy();

    review.open = true;
    await userEvent.type(within(review).getByLabelText('What part 1 does'), '!');
    expect(onBreakdownChange.mock.calls.at(-1)[0].scenes[0].purpose).toBe('Hook!');
  });
});

describe('Reference video: when the breakdown fails', () => {
  it('gives the reason and a way to try again', async () => {
    show(project({ ...video, breakdown: null, use: false }, { referenceStatus: 'failed', referenceError: 'The model is busy.' }));
    expect(screen.getByRole('alert').textContent).toMatch(/could not be broken down: The model is busy\./);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(analyseReference).toHaveBeenCalledWith('p1', video.storageRef, 'ad.mp4');
  });
});
