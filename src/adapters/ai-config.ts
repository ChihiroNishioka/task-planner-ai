/** AI_MODE=cli のときだけサブスクCLIの実AIを使う。既定はモック。DBを開かずに参照できるよう分けている。 */
export const aiMode: 'cli' | 'mock' = process.env.AI_MODE === 'cli' ? 'cli' : 'mock';
