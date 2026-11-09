import {imageProposalApi} from '../../../../../../../adapters/runtime';
export const runtime='nodejs';
export async function GET(request:Request,context:{params:Promise<{id:string;inputId:string}>}){const {id,inputId}=await context.params;return imageProposalApi.contentGET(request,id,inputId);}
