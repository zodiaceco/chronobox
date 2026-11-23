import { poll } from '../service.ts';
import { vercelFunction } from '../vercel.ts';

export default vercelFunction(poll);
