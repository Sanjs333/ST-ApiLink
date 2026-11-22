import * as nativeLibraries from '../../../../../lib.js';
import * as bundledLibraries from './vendor/libraries.mjs';

// 1.13.x does not export YAML; older releases also lack SHA-256.
export const yaml = nativeLibraries.yaml ?? bundledLibraries.yaml;
export const sha256 = nativeLibraries.sha256 ?? bundledLibraries.sha256;
