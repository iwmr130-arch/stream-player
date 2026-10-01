const urlInput = document.getElementById('url-input') as HTMLInputElement;
const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
const container = document.getElementById('webview-container') as HTMLDivElement;

let webview: any = null;

function loadUrl(): void {
  let url = urlInput.value.trim();
  if (!url) {
    alert('URLを入力してください');
    return;
  }

  // URLにプロトコルがなければ https:// を追加
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  // 既存のwebviewを削除
  if (webview) {
    webview.remove();
    webview = null;
  }

  // 新しいwebviewを作成
  webview = document.createElement('webview');
  webview.src = url;
  webview.style.cssText = 'width: 100%; height: 100%;';
  webview.addEventListener('did-fail-load', () => {
    alert('ページの読み込みに失敗しました');
    container.textContent = 'URLを入力して [読み込み] を押してください';
  });
  webview.addEventListener('did-finish-load', () => {
    console.log('Page loaded:', url);
  });

  container.innerHTML = '';
  container.appendChild(webview);
}

loadBtn.addEventListener('click', loadUrl);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadUrl();
});
