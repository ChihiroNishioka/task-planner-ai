import {imageProposalApi} from '../../../../../adapters/runtime';
export const runtime='nodejs';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return imageProposalApi.imageGET(request,(await context.params).id);}
