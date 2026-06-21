'use strict';

module.exports = function createPlatform(env) {
  if (process.platform === 'win32') return require('./win32')(env);
  const error = new Error(`Codex Max VSCode 本地版只支持 Windows，当前系统是 ${process.platform}。`);
  error.code = 'UNSUPPORTED_PLATFORM';
  throw error;
};
