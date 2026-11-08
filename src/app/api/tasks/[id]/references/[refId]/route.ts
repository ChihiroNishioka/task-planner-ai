import { referenceApi } from '../../../../../../adapters/runtime';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; refId: string }> };
export async function PATCH(request: Request, context: Context) { const { id, refId } = await context.params; return referenceApi.handle(request, id, refId); }
export async function DELETE(request: Request, context: Context) { const { id, refId } = await context.params; return referenceApi.handle(request, id, refId); }
