import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { extractText } from '../src/domain/html-text';

const html = (source: string) => extractText(source, 'text/html', 'example.com');
describe('URL取り込みのタイトル', () => {
  it('UF-TTL-01 BBC型のsvg titleを題名に混ぜない', () => {
    expect(html('<head><title>記事の題</title></head><body><svg><title>British Broadcasting Corporation</title><title>ロゴ</title></svg><main>本文</main></body>').title).toBe('記事の題');
  });
  it('UF-TTL-02 NHK型の地域選択を題名に混ぜない', () => {
    expect(html('<head><title>ニュース</title></head><body><main>記事</main><svg><title>地域を選択</title></svg></body>').title).toBe('ニュース');
  });
  it('UF-TTL-03 titleが無ければheadのog:title', () => {
    expect(html('<head><meta property="og:title" content="A"></head><h1>見出し</h1>').title).toBe('A');
  });
  it.each([
    '<meta name="og:title" content="A">', '<meta content="A" property="og:title">',
    "<meta property='og:title' content='A'>", '<meta property=og:title content=A>',
    '<META PROPERTY="OG:TITLE" CONTENT="A">', '<meta content="A &gt; B" name="og:title">',
  ])('UF-TTL-04 属性の順序・引用符・大文字・文字参照 %s', meta => {
    expect(html(`<head>${meta}</head><h1>見出し</h1>`).title).toBe(meta.includes('&gt;') ? 'A > B' : 'A');
  });
  it('UF-TTL-05 body内のog:titleは採用しない', () => {
    expect(html('<body><meta property="og:title" content="偽題"><h1>見出し</h1></body>').title).toBe('見出し');
  });
  it('UF-TTL-06 h1とホスト名へのフォールバック', () => {
    expect(html('<h1>見出し</h1><p>本文</p>').title).toBe('見出し');
    expect(html('<p>本文</p>').title).toBe('example.com');
  });
  it('UF-TTL-07 head省略のtitleを採用し本文から省く', () => {
    expect(html('<title>題名</title><p>本文</p>')).toMatchObject({ title: '題名', body: '本文' });
  });
  it('UF-TTL-08 titleをRCDATAとして読む', () => {
    expect(html('<title>a<b>c</title><p>本文</p>')).toMatchObject({ title: 'a<b>c', body: '本文' });
  });
  it('UF-TTL-09 閉じていないtitleを採用せず本文を読む', () => {
    expect(html('<title>未完<h1>見出し</h1><p>本文</p>')).toMatchObject({ title: '見出し' });
    expect(html('<title>未完<h1>見出し</h1><p>本文</p>').body).toContain('本文');
  });
  it('UF-TTL-10 最初のtitleが空ならogへ進み2個目を使わない', () => {
    expect(html('<head><title> </title><title>後の題</title><meta property="og:title" content="OG"></head><p>本文</p>').title).toBe('OG');
  });
});

describe('URL取り込みの本文', () => {
  it('UF-BODY-01 NHK型はmainの記事から始まる', () => {
    expect(html('<nav>閉じる メニュー</nav><main><h1>記事</h1><p>本文</p></main>').body).toBe('記事\n本文');
  });
  it('UF-BODY-02 BBC型はskip linkと外側headerを省く', () => {
    expect(html('<a>Skip to content</a><header>ロゴ</header><nav>一覧</nav><main>記事本文</main>').body).toBe('記事本文');
  });
  it('UF-BODY-03 Wikipedia型は目次を省き選んだ本文の5万字まで', () => {
    const result = html(`<nav>目次</nav><main><nav>目次</nav>${'字'.repeat(50_001)}</main>`);
    expect(result.body).toBe('字'.repeat(50_000));
    expect(result.truncated).toBe(true);
  });
  it('UF-BODY-04 main外の大きさで切り詰め扱いにしない', () => {
    expect(html(`<div>${'外'.repeat(50_001)}</div><main>本文</main>`)).toMatchObject({ body: '本文', truncated: false });
  });
  it('UF-BODY-05 note型articleの外側footerを省く', () => {
    expect(html('<article>短い記事</article><footer>フッター</footer>').body).toBe('短い記事');
  });
  it('UF-BODY-06 navigation banner contentinfo complementary searchを省く', () => {
    expect(html('<main>' + ['navigation', 'banner', 'contentinfo', 'complementary', 'search'].map(role => `<div role="${role}">除外</div>`).join('') + '<p>本文</p></main>').body).toBe('本文');
  });
  it('UF-BODY-07 article内のheaderと見出しは残す', () => {
    expect(html('<article><header><h1>記事題名</h1>日付</header><p>本文</p></article>').body).toContain('記事題名');
    expect(html('<article><header>日付</header><p>本文</p></article>').body).toContain('日付');
  });
  it('UF-BODY-08 article内でもbanner aside navは省く', () => {
    expect(html('<article><header role="banner">除外</header><aside>除外</aside><nav>除外</nav><p>本文</p></article>').body).toBe('本文');
  });
  it('UF-BODY-09 見える最長mainだけを選ぶ', () => {
    expect(html('<main hidden>不可視の長い本文</main><main>短</main><main role="main">選ばれる本文</main>').body).toBe('選ばれる本文');
  });
  it('UF-BODY-10 最長articleが過半なら1個だけ', () => {
    expect(html('<article>短</article><article>長い記事の本文</article>').body).toBe('長い記事の本文');
  });
  it('UF-BODY-11 同程度の一覧articleを文書順に連結し入れ子を重複しない', () => {
    expect(html('<article>甲甲<article>甲甲</article></article><article>乙乙乙乙</article><article>丙丙丙丙</article>').body).toBe('甲甲\n甲甲\n乙乙乙乙\n丙丙丙丙');
  });
  it('UF-BODY-12 空mainなら省く要素以外の全体に戻る', () => {
    expect(html('<nav>除外</nav><main></main><p>本文</p>').body).toBe('本文');
  });
  it('UF-BODY-13 navのみならhidden以外の全体に戻る', () => {
    expect(html('<nav>案内<span hidden>秘密</span></nav>').body).toBe('案内');
  });
  it('UF-BODY-14 閉じていないnavでも本文を失わない', () => {
    expect(html('<nav>案内<p>本文</p>').body).toContain('本文');
  });
  it('UF-BODY-15 aside内のarticleを本文候補にしない', () => {
    expect(html('<aside><article>誤った候補</article></aside><p>本文</p>').body).toBe('本文');
  });
  it('UF-BODY-16 text/plainをHTMLとして解釈しない', () => {
    expect(extractText(' <nav>文字</nav> &amp; ', 'text/plain', 'example.com').body).toBe('<nav>文字</nav> &');
  });
});

describe('URL取り込みの一部取得判定', () => {
  it('UF-PART-01 50001コードポイントは切り詰め', () => {
    expect(html(`<main>${'😀'.repeat(50_001)}</main>`)).toMatchObject({ body: '😀'.repeat(50_000), truncated: true, contentHint: null });
  });
  it('UF-PART-02 50000コードポイントは切り詰めない', () => {
    expect(html(`<main>${'😀'.repeat(50_000)}</main>`)).toMatchObject({ truncated: false, contentHint: null });
  });
  it('UF-PART-03 タイトル301字だけではtruncatedにしない', () => {
    expect(html(`<title>${'題'.repeat(301)}</title><main>本文</main>`)).toMatchObject({ title: '題'.repeat(300), truncated: false });
  });
  it('UF-PART-04 HTML本文599字と600字の境界', () => {
    expect(html(`<p>${'😀'.repeat(599)}</p>`)).toMatchObject({ contentHint: 'SHORT_BODY' });
    expect(html(`<p>${'😀'.repeat(600)}</p>`)).toMatchObject({ contentHint: null });
  });
  it('UF-PART-05 有料の手掛かりは本文外も調べ短文より優先する', () => {
    expect(html(`<article>${'字'.repeat(1500)}</article><section>この続きをみるには</section>`)).toMatchObject({ body: '字'.repeat(1500), contentHint: 'PAYWALL_HINT' });
    expect(html('<article>短文</article><section>SUBSCRIBE TO READ</section>')).toMatchObject({ contentHint: 'PAYWALL_HINT' });
    expect(html('<article>短文</article><nav>この続きをみるには</nav>')).toMatchObject({ contentHint: 'SHORT_BODY' });
  });
  it('UF-PART-06 手掛かりがあっても本文2000字以上ならhintなし', () => {
    expect(html(`<article>${'字'.repeat(2000)}</article><section>有料会員限定</section>`)).toMatchObject({ contentHint: null });
  });
  it('UF-PART-07 短いtext/plainはhintなし', () => {
    expect(extractText('本文', 'text/plain', 'example.com')).toMatchObject({ contentHint: null });
  });
});


describe('HTML抽出の計算量と文字参照の回帰', () => {
  it.each(['html', 'deep'])('C01 %s の約2MiBのHTMLを2秒以内に抽出する', async shape => {
    const script = `
      require('tsx/cjs');
      const { parentPort } = require('node:worker_threads');
      const { extractText } = require('./src/domain/html-text.ts');
      const source = ${JSON.stringify(shape)} === 'html'
        ? '本文' + '<html>'.repeat(349000)
        : '本文' + '<div>'.repeat(190000) + '</div>'.repeat(190000);
      const started = performance.now();
      const result = extractText(source, 'text/html', 'example.com');
      parentPort.postMessage({ elapsed: performance.now() - started, body: result.body.slice(0, 2) });
    `;
    const result = await new Promise<unknown>((resolve, reject) => {
      const worker = new Worker(script, { eval: true });
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error('extractTextが2秒以内に終了しませんでした'));
      }, 2000);
      worker.once('message', value => { clearTimeout(timer); void worker.terminate(); resolve(value); });
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error(`Worker終了コード ${code}`)); } });
    });
    expect(result).toEqual({ elapsed: expect.any(Number), body: '本文' });
  }, 8000);

  it.each(['<title>A &amp;lt; B</title>', '<meta property="og:title" content="A &amp;lt; B">'])(
    'C02 titleとog:titleの文字参照は1回だけ復元する %s', source => {
      expect(html(`<head>${source}</head><p>本文</p>`).title).toBe('A &lt; B');
    },
  );
});


describe('C11 解析上限で生HTMLを本文に流さない', () => {
  it.each(['script', 'style', 'nav', 'main'])('C11 タグ上限の直前・直後の%sを取り込まない', tag => {
    for (const count of [19998, 19999]) {
      const result = html(`<main>確定した本文${'<br>'.repeat(count)}<${tag}>上限後の文字</${tag}></main><main>${'後'.repeat(60000)}</main>`);
      expect(result.body).toBe('確定した本文');
      expect(result.truncated).toBe(true);
      expect(result.contentHint).toBeNull();
    }
  });
  it.each(['script', 'style', 'nav', 'main'])('C11 深さ上限の直前・直後の%sと残りの入力を打ち切る', tag => {
    for (const depth of ['script', 'style'].includes(tag) ? [999] : [998, 999]) {
      const result = html(`<main>確定した本文${'<div>'.repeat(depth)}<${tag}><div>上限後の文字</div></${tag}>${'</div>'.repeat(depth)}</main><main>${'後'.repeat(60000)}</main>`);
      expect(result.body).toBe('確定した本文');
      expect(result.truncated).toBe(true);
      expect(result.contentHint).toBeNull();
    }
  });
  it('C11 上限ちょうどで入力が終わる場合は欠落としない', () => {
    expect(html(`<main>本文${'<br>'.repeat(19998)}</main>`)).toMatchObject({ body: '本文', truncated: false });
    expect(html(`<main>${'<div>'.repeat(999)}本文${'</div>'.repeat(999)}</main>`)).toMatchObject({ body: '本文', truncated: false });
  });
});
