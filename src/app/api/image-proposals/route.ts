import {imageProposalApi} from '../../../adapters/runtime';
export const runtime='nodejs';
export async function POST(request:Request) { return imageProposalApi.POST(request); }
