import { health } from '../service.ts';
import { vercelFunction } from '../vercel.ts';

export default vercelFunction(health);
