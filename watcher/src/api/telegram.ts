import { telegramWebhook } from '../service.ts';
import { vercelFunction } from '../vercel.ts';

export default vercelFunction(telegramWebhook);
