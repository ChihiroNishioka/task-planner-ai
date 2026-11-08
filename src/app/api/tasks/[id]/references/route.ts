import { referenceApi } from '../../../../../adapters/runtime';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return referenceApi.handle(request, (await context.params).id); }
export async function POST(request: Request, context: Context) { return referenceApi.handle(request, (await context.params).id); }
