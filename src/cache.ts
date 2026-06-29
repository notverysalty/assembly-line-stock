import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Tick } from './types';

/** 多窗口共享的行情缓存文件（系统临时目录） */
const CACHE_FILE = path.join(os.tmpdir(), 'vscode-stock-watcher-cache.json');

export interface CacheEntry {
  ts: number; // 写入时间戳（ms）
  tick: Tick;
}
export type Cache = Record<string, CacheEntry>;

/** 读共享缓存（容错：文件不存在 / 损坏 → 返回空缓存，绝不抛错） */
export function readCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

/**
 * 原子写共享缓存：先写带 pid 的临时文件再 rename。
 * rename 在同一文件系统是原子操作，避免多窗口并发写出半截损坏的 JSON。
 */
export function writeCache(cache: Cache): void {
  try {
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error('[stock-watcher] writeCache failed:', e);
  }
}

/** 通用 JSON 文件缓存（如节假日数据），file 为临时目录下的文件名 */
export function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), file), 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function writeJsonFile(file: string, data: unknown): void {
  try {
    const full = path.join(os.tmpdir(), file);
    const tmp = `${full}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, full);
  } catch (e) {
    console.error('[stock-watcher] writeJsonFile failed:', e);
  }
}
