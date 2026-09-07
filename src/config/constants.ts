/** CLI 固定配置与包元数据。@author xiuyu.yi */
import { createRequire } from 'node:module';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const metadata = z
  .object({
    name: z.string(),
    version: z.string(),
    private: z.boolean().optional(),
    publishConfig: z.object({ registry: z.string().url() }),
  })
  .parse(require('../../package.json'));

export const PACKAGE_NAME = metadata.name;
export const PACKAGE_VERSION = metadata.version;
export const PACKAGE_PRIVATE = metadata.private === true;
export const NPM_REGISTRY = metadata.publishConfig.registry;
export const COMMAND_NAME = 'superun-create';
export const SCHEMA_VERSION = '1';
export const DEFAULT_ENDPOINT = 'https://superun.com';
export const PRE_ENDPOINT = 'https://superun.pre.qima-inc.com';
export const PAT_PREFIX = 'sup_pat_';
export const DEFAULT_WAIT_SECONDS = 1800;
