import {imageProposalApi} from '../../../../../adapters/runtime';
export const runtime='nodejs';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return imageProposalApi.taskPOST(request,(await context.params).id);}
