'use strict';

module.exports = function createPlatform(env) {
  if (process.platform === 'win32') return require('./win32')(env);
  if (process.platform === 'darwin') return require('./darwin')(env);
  const error = new Error(`Codex Max 暂不支持当前系统：${process.platform}`);
  error.code = 'UNSUPPORTED_PLATFORM';
  throw error;
};
