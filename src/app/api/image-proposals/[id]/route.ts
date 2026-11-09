import {imageProposalApi} from '../../../../adapters/runtime';
export const runtime='nodejs';
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context){return imageProposalApi.GET(request,(await context.params).id);}
export async function DELETE(request:Request,context:Context){return imageProposalApi.DELETE(request,(await context.params).id);}
