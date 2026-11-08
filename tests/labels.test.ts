import { describe, expect, it } from 'vitest';
import { aiStatusLabel, categoryLabel, inputTypeLabel, jobStatusLabel, reviewApprovalLabel, reviewRatingLabel, saveStatusLabel, statusLabel, taskTypeLabel, userMessage } from '../src/domain/labels';
import { aiStatusSchema, taskCategorySchema, taskStatusSchema, taskTypeSchema } from '../src/domain/task';

const hasJapanese = /[぀-ヿ一-鿿]/;
const asciiOnly = /^[\x20-\x7e]+$/;

describe('日本語の状態ラベル', () => {
  it('全ての内部enum値に日本語ラベルがあり、英字のままにならない', () => {
    for (const value of taskStatusSchema.options) expect(statusLabel(value)).toMatch(hasJapanese);
    for (const value of aiStatusSchema.options) expect(aiStatusLabel(value)).toMatch(hasJapanese);
    for (const value of taskTypeSchema.options) expect(taskTypeLabel(value)).toMatch(hasJapanese);
    for (const value of taskCategorySchema.options) expect(categoryLabel(value)).toMatch(hasJapanese);
    for (const value of ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']) expect(jobStatusLabel(value)).toMatch(hasJapanese);
    for (const value of ['AUDIO', 'IMAGE', 'PDF']) expect(inputTypeLabel(value)).toMatch(hasJapanese);
    for (const value of ['UNRATED', 'GOOD', 'BAD']) expect(reviewRatingLabel(value)).toMatch(hasJapanese);
    for (const value of ['UNAPPROVED', 'APPROVED', 'REVOKED']) expect(reviewApprovalLabel(value)).toMatch(hasJapanese);
    expect(saveStatusLabel('MOCK_SAVED')).toMatch(hasJapanese);
  });

  it('未知の値でも英字の内部値をそのまま出さない', () => {
    expect(statusLabel('SOMETHING_NEW')).not.toMatch(asciiOnly);
    expect(aiStatusLabel('SOMETHING_NEW')).not.toMatch(asciiOnly);
  });

  it('userMessage は日本語の文だけを通し、英語の例外は代替文にする', () => {
    expect(userMessage(new Error('タスクを読み込めませんでした。'), '代替')).toBe('タスクを読み込めませんでした。');
    expect(userMessage(new TypeError('Failed to fetch'), '通信できませんでした。')).toBe('通信できませんでした。');
    expect(userMessage('boom', '代替')).toBe('代替');
  });
});
