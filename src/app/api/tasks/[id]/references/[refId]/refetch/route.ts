import { referenceApi } from '../../../../../../../adapters/runtime';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string; refId: string }> }) { const { id, refId } = await context.params; return referenceApi.handle(request, id, refId, 'refetch'); }
