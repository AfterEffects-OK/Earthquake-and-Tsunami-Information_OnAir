// --- ふりがな辞書 (動的生成) ---
let KANA_DICT = {};

/**
 * カタカナをひらがなに変換する
 * @param {string} str - カタカナ文字列
 * @returns {string} ひらがな文字列
 */
const katakanaToHiragana = (str) => {
    if (!str) return '';
    return str.replace(/[\u30A1-\u30F6]/g, (match) => {
        const chr = match.charCodeAt(0) - 0x60;
        return String.fromCharCode(chr);
    });
};

/**
 * 気象庁の定義ファイルから地名の読み仮名辞書を生成する
 */
const buildKanaDictionary = async () => {
    try {
        const response = await fetch('https://www.jma.go.jp/bosai/common/const/area.json');
        if (!response.ok) {
            throw new Error(`Failed to fetch area.json: ${response.status}`);
        }
        const data = await response.json();
        const newDict = {};

        // 都道府県 (centers), 一次細分区域 (offices), 市区町村 (class20s) から辞書を構築
        const areasToParse = { ...data.centers, ...data.offices, ...data.class20s };

        Object.values(areasToParse).forEach(area => {
            if (area.name && area.kana) {
                newDict[area.name] = area.kana;
            }
        });

        KANA_DICT = newDict;
        console.log('読み仮名辞書の生成が完了しました。', `(${Object.keys(KANA_DICT).length}件)`);

    } catch (error) {
        console.error('読み仮名辞書の生成に失敗しました:', error);
    }
};

// 処理された地震データを保持する変数
let PROCESSED_EARTHQUAKES = [];
// グローバルな表示モード: 'point' (観測点別) または 'municipality' (市区町村別/デフォルト)
let DISPLAY_MODE = 'municipality'; // 初期値を市区町村別に変更
// 追加: 最後にデータを取得した日時を保持
let LAST_FETCH_TIME = null;
// 訓練モードの状態を管理するグローバル変数
let USE_DUMMY_DATA = false;

// --- 固定バー用のグローバル変数 ---
// 概況ビュー(インデックス0) + 震度別地域ビュー の全てのビューを格納
let FIXED_BAR_VIEWS = []; 
let CURRENT_SHINDO_INDEX = 0; // 現在フッターに表示されているビューのインデックス
// ---------------------------------

// --- 自動ページ送り用のグローバル変数 ---
let autoplayIntervalId = null;
let isAutoplaying = false;
let autoplayLoopCounter = 0;
let refreshIntervalId = null; // 自動更新のタイマーIDを保持
// 新しい地震を検知し、自動再生を待機している状態を示すフラグ
let isWaitingForAutoplay = false; 
// ------------------------------------

// --- ショートカットキー用のグローバル変数 ---
let shortcutSetting = {
    ctrl: false,
    alt: false,
    shift: false,
    key: 'Space' // デフォルト
};
// ------------------------------------

// --- ループ再生設定用のグローバル変数 ---
let loopPlaybackMinScale = 30; // デフォルトは震度3以上
// ------------------------------------
// --- EEW通知音設定用のグローバル変数 ---
let playEewSound = true; // デフォルトはON
let eewAudioObject = null; // プリロード用のAudioオブジェクト
// --- 連続EEW対応用のグローバル変数 ---
let eewQueue = []; // 表示すべきEEW情報を保持するキュー
let eewDisplayIntervalId = null; // EEWを10秒ごとに切り替えるためのタイマーID
let eewClearTimeoutId = null; // 60秒後にEEW表示をすべてクリアするためのタイマーID
let currentEewIndex = 0; // 現在表示しているEEWのインデックス


/**
 * 手動でふりがなを登録するための辞書（データベース）
 * キー: "都道府県名_市区町村名"
 * 値: "ひらがな"
 * 
 * 例:
 * "福岡県_福岡市早良区": "ふくおかしさわらく",
 * "宮崎県_都農町": "つのちょう",
 * "福島県_伊達市": "だてし",
 */
let MANUAL_KANA_DICT = {
    // ここに手動でふりがなを登録します
};

// グローバル参照: モーダル内の入力フィールド
let kanaKeyInput = null;
let kanaValueInput = null;

/**
 * 漢字の地名から、ふりがな辞書を使って読み仮名を取得する
 * @param {string} kanji - 漢字の地名 ("都道府県名_市区町村名" の形式)
 * @returns {string} 読み仮名（ひらがな）。辞書になければ空文字列を返す
 */
const getKana = (kanji) => {
    if (!kanji) return '';

    // 1. 手動登録辞書を最優先で検索。キーが存在すれば、その値（空文字列を含む）を返す
    if (MANUAL_KANA_DICT.hasOwnProperty(kanji)) {
        return MANUAL_KANA_DICT[kanji];
    }

    // "都道府県名_市区町村名" の形式を想定
    const parts = kanji.split('_');
    const municipality = parts.length > 1 ? parts[1] : parts[0];

    // 辞書検索
    const kana = KANA_DICT[municipality] || KANA_DICT[municipality.replace(/（.+?）/g, '')] || ''; // "（" 以降を削除しても検索
    return katakanaToHiragana(kana);
};

// --- ユーティリティ関数と設定 ---

const CONFIG = {
    // P2P地震情報 API v2のエンドポイント (地震情報コード551は「震源・震度情報」)
    API_URL: 'https://api.p2pquake.net/v2/history?limit=100',
    
    // 地震一覧に表示する地震の「最大」震度の最低ライン (30: 震度3)
    MIN_LIST_SCALE: 30,
    
    // 詳細パネルの震度別観測地点に表示する「観測点」の最低震度ライン (10: 震度1)
    MIN_DETAIL_SCALE: 10,

    // 固定バーの1ページあたりに表示する市区町村の最大数
    CITIES_PER_PAGE: 15,

    // APIを自動更新する間隔（ミリ秒）。2分 = 120000ms
    REFRESH_INTERVAL_MS: 2 * 60 * 1000,

    // 【要設定】Google Apps ScriptのウェブアプリURL
    GAS_WEB_APP_URL: 'https://script.google.com/macros/s/AKfycbycK2ARMIU1L3mKQYcvsDzCXYRpnOAbAvZmknDzk4cp3_H6gh7IoBkYJTVM3da5nWTi/exec', // ← 地震情報記録用

    // 【要設定】観測点情報記録用のGoogle Apps ScriptウェブアプリURL
    GAS_POINTS_WEB_APP_URL: 'https://script.google.com/macros/s/AKfycbyKZMDItp342Im5b_PBvpp8X5ST3AH8Ltx6nxdwJiN-QnM9isxavmfKcKrClSzUYG1Dmg/exec', // ← ここに観測点情報用の新しいウェブアプリURLを貼り付けてください
};

/**
 * テキストが指定された要素の2行分の高さに収まるか測定するヘルパー関数
 * @param {string} htmlContent - 測定するHTMLコンテンツ
 * @param {HTMLElement} targetElement - スタイル（幅、フォントサイズなど）の基準となる要素
 * @returns {boolean} 2行に収まる場合はtrue、収まらない場合はfalse
 */
const doesTextFitInTwoLines = (htmlContent, targetElement) => {
    // 1. 画面外にダミーの測定用要素を作成
    const measureDiv = document.createElement('div');
    measureDiv.style.position = 'absolute';
    measureDiv.style.left = '-9999px'; // 画面外に配置
    measureDiv.style.visibility = 'hidden';

    // 2. ターゲット要素のスタイルをコピー
    const targetStyle = window.getComputedStyle(targetElement);
    measureDiv.style.width = targetStyle.width;
    measureDiv.style.font = targetStyle.font;
    measureDiv.style.lineHeight = targetStyle.lineHeight;
    measureDiv.style.wordBreak = 'keep-all'; // 分割判定のスタイルを合わせる

    // 3. コンテンツを入れて高さを測定
    measureDiv.innerHTML = htmlContent;
    document.body.appendChild(measureDiv);
    const contentHeight = measureDiv.scrollHeight;
    const lineHeight = parseFloat(targetStyle.lineHeight);
    document.body.removeChild(measureDiv); // 測定が終わったら削除

    // 4. 2行分の高さを超えているか判定
    return contentHeight <= (lineHeight * 2 + 2); // 誤差を考慮して少し余裕を持たせる
};


// 震度階級の数値コードを文字列に変換し、バッジの色クラスを返す
const scaleToShindo = (scale) => {
    switch (scale) {
        // '震度' のテキストを追加
        case 10: return { label: '震度1', class: 'shindo-1' };
        case 20: return { label: '震度2', class: 'shindo-2' };
        case 30: return { label: '震度3', class: 'shindo-3' }; 
        case 40: return { label: '震度4', class: 'shindo-4' };
        case 45: return { label: '震度5弱', class: 'shindo-5-minus' };
        case 50: return { label: '震度5強', class: 'shindo-5-plus' };
        case 55: return { label: '震度6弱', class: 'shindo-6-minus' };
        case 60: return { label: '震度6強', class: 'shindo-6-plus' };
        case 70: return { label: '震度7', class: 'shindo-7' };
        default: return { label: '震度不明', class: 'bg-gray-400 text-white' };
    }
};

// 震度階級をソートするためのマップ（降順）
// ラベルに「震度」を追加したため、マップのキーも更新
const SHINDO_SORT_ORDER = {
    '震度7': 9, '震度6強': 8, '震度6弱': 7, '震度5強': 6, '震度5弱': 5, '震度4': 4, '震度3': 3, '震度2': 2, '震度1': 1
};

// APIデータ（ISO String）を整形（YYYY/MM/DD HH:mm）
const formatDateTime = (isoString) => {
    if (!isoString) return '不明';
    try {
        // ISO 8601形式の文字列を直接Dateオブジェクトに変換
        const date = new Date(isoString);
        const y = date.getFullYear();
        const mo = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const h = String(date.getHours()).padStart(2, '0');
        const m = String(date.getMinutes()).padStart(2, '0');
        return `${y}/${mo}/${d} ${h}:${m}`;
    } catch (e) {
        return '日時不明';
    }
};

/**
 * 現在の時刻を整形（YYYY/MM/DD HH:mm:ss）
 * @param {Date} date - Dateオブジェクト
 * @returns {string} フォーマットされた日時文字列
 */
const formatCurrentTime = (date) => {
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}/${mo}/${d} ${h}:${m}:${s}`;
};

/**
 * 時刻文字列 (HH:mm) を「午前/午後 X時Y分」形式に変換する
 * @param {string} timeString - "HH:mm" 形式の時刻文字列
 * @returns {string} フォーマットされた時刻文字列
 */
const formatTimeForTelop = (timeString) => {
    if (!timeString || !timeString.includes(':')) {
        return '';
    }
    const [hour, minute] = timeString.split(':').map(num => parseInt(num, 10));

    if (isNaN(hour) || isNaN(minute)) {
        return '';
    }

    const ampm = hour < 12 ? '午前' : '午後';
    const displayHour = hour % 12 === 0 ? (hour === 12 ? 12 : 0) : hour % 12;

    return `${ampm} ${displayHour}時 ${minute}分`;
};


/**
 * 文字列からMD5ハッシュを生成する非同期関数
 * @param {string} message - ハッシュ化する文字列
 * @returns {Promise<string>} 16進数文字列のハッシュ
 */
const digestMessage = async (message) => {
    const msgUint8 = new TextEncoder().encode(message); // 文字列をUint8Arrayにエンコード
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8); // ハッシュを計算
    const hashArray = Array.from(new Uint8Array(hashBuffer)); // バッファを配列に変換
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join(''); // 16進数文字列に変換
    return hashHex;
};



/**
 * 観測点名から市町村名（政令指定都市の区まで含む）を抽出する
 * @param {string} addr - 観測点名 (point.addr)
 * @param {string} pref - 都道府県名 (point.pref)
 * @returns {string} "都道府県名_市区町村名" の形式の文字列
 */
const getMunicipality = (addr, pref) => {
    if (!addr || !pref) return `${pref || '不明'}_${addr || '観測点名不明'}`;

    // 北海道の支庁名などに対応するため、都道府県名除去前のフルアドレスでまず検索
    // 例: 「北海道釧路市」-> 辞書に「釧路市」があればそれを使う
    const directMatch = Object.keys(KANA_DICT).find(key => addr.includes(key) && (addr.endsWith(key) || addr.includes(key + ' ')));
    if (directMatch) {
        // マッチした場合でも、都道府県名を付けて返す
        return `${pref}_${directMatch}`;
    }

     let remainingAddr = addr;

    // 1. 都道府県名を先に除去する
     if (remainingAddr.startsWith(pref)) {
        remainingAddr = remainingAddr.substring(pref.length);
     } else {
         // 都道府県名で始まらない場合（例: 「仙台市宮城野区」）、他の都道府県名も除去してみる
         const prefs = ['東京都', '北海道', '京都府', '大阪府'];
         prefs.forEach(p => {
             if (remainingAddr.startsWith(p)) remainingAddr = remainingAddr.substring(p.length);
         });
         const prefIndex = remainingAddr.indexOf('県');
         if (prefIndex !== -1) {
             remainingAddr = remainingAddr.substring(prefIndex + 1);
         }
     }

     // パターン1: 「〇〇市〇〇区」を優先的にマッチ (例: 仙台市宮城野区)
    const cityAndWardMatch = remainingAddr.match(/^.+?市.+?区/);
    if (cityAndWardMatch) return `${pref}_${cityAndWardMatch[0]}`;

     // パターン2: 「〇〇郡〇〇町/村」の場合、郡名と町村名を抽出 (例: 北海道空知郡南幌町 -> 空知郡南幌町)
    const gunMatch = remainingAddr.match(/^.+?郡.+?(町|村)/);
    if (gunMatch) return `${pref}_${gunMatch[0]}`;

    // ★★★ 修正: パターン3の前に、辞書との前方一致を試す ★★★
    // これにより「伊達市梁川町」->「伊達市」のように、辞書にある市区町村名を優先的に抽出する
    // 最も長い一致を見つけるために、辞書のキーを文字数の長い順にソート
    const sortedKanaKeys = Object.keys(KANA_DICT).sort((a, b) => b.length - a.length);
    const forwardMatch = sortedKanaKeys.find(key => remainingAddr.startsWith(key));

    if (forwardMatch) return `${pref}_${forwardMatch}`;

    // パターン3: 「〇〇市」「〇〇区」「〇〇町」「〇〇村」 (例: 栃木市入舟町 -> 栃木市, 廿日市市 -> 廿日市市)
    const cityTownVillageMatch = remainingAddr.match(/^.+?(市|区|町|村)/);

    if (cityTownVillageMatch) return `${pref}_${cityTownVillageMatch[0]}`;

    // どのパターンにもマッチしない場合は、元の観測点名を返す
    return `${pref}_${addr}`;
};

/**
 * 緊急地震速報(EEW)を処理し、アラートを表示する
 * @param {object} eewData - APIから取得したEEWのデータ (code: 554)
 */
const handleEew = (eewData) => {
    // エラー防止: 必要なDOM要素と、eewDataにearthquakeオブジェクトが存在することを確認
    if (!eewData.earthquake) return;

    // エラー防止: maxScale, hypocenter, magnitude が存在しない場合に備える
    const maxScaleValue = eewData.earthquake.maxScale;
    const maxScale = (maxScaleValue !== undefined && maxScaleValue !== null) ? scaleToShindo(maxScaleValue).label : '不明';

    const hypocenter = eewData.earthquake.hypocenter?.name || '震源情報なし';
    const magnitude = eewData.earthquake.magnitude;

    let alertText = `【緊急地震速報】 ${hypocenter}で地震発生`;
    if (maxScale !== '震度不明') {
        alertText += ` 予想最大震度 ${maxScale}`;
    }
    if (magnitude > 0) {
        alertText += ` M${magnitude}`;
    }

    // 設定が有効な場合、通知音を再生
    if (playEewSound && eewAudioObject) {
        let playCount = 0;
        const maxPlayCount = 2; // 再生回数を2回に設定

        const playSound = () => {
            eewAudioObject.currentTime = 0; // 再生位置を最初に戻す
            eewAudioObject.play().catch(error => {
                console.warn(`EEW通知音の再生に失敗しました (${playCount + 1}回目):`, error);
            });
        };

        const onSoundEnded = () => {
            playCount++;
            if (playCount < maxPlayCount) {
                playSound(); // 次の再生を実行
            } else {
                eewAudioObject.removeEventListener('ended', onSoundEnded); // 2回再生が終わったらリスナーを削除
            }
        };

        eewAudioObject.removeEventListener('ended', onSoundEnded); // 念のため既存のリスナーを削除
        eewAudioObject.addEventListener('ended', onSoundEnded);
        playSound(); // 1回目の再生を開始
    }

    // --- 連続EEW対応: キューに情報を追加 ---
    // 既に同じIDのEEWがキューにあれば追加しない
    if (eewQueue.some(e => e.id === eewData.id)) {
        return;
    }

    eewQueue.push({ id: eewData.id, text: alertText, data: eewData });
    // 新しいEEWが追加されるたびに表示サイクルを開始（またはタイマーをリセット）する
    startEewDisplayCycle();
};

/**
 * EEWアラートの表示サイクルを開始・管理する
 */
const startEewDisplayCycle = () => {
    const container = document.getElementById('eew-alert-container');
    const alertTextElement = document.getElementById('eew-alert-text');
    if (!container || !alertTextElement) return;

    // 既存のタイマーをクリア（表示切り替えタイマーは、キューが1つの場合はリセットしない）
    if (eewQueue.length > 1 && eewDisplayIntervalId) clearInterval(eewDisplayIntervalId);
    if (eewClearTimeoutId) clearTimeout(eewClearTimeoutId);

    currentEewIndex = 0;

    // 最初の情報をすぐに表示
    if (eewQueue.length > 0) {
        alertTextElement.textContent = eewQueue[0].text;
        container.classList.remove('hidden');
        container.classList.add('flex');
    }

    // 10秒ごとに表示を切り替えるタイマーを設定（まだ設定されていなければ）
    if (!eewDisplayIntervalId) {
        eewDisplayIntervalId = setInterval(() => {
            if (eewQueue.length > 1) {
                currentEewIndex = (currentEewIndex + 1) % eewQueue.length;
                alertTextElement.textContent = eewQueue[currentEewIndex].text;
            }
        }, 10000);
    }

    // 60秒後にすべてをクリアするタイマーを設定
    eewClearTimeoutId = setTimeout(() => {
        stopEewDisplayCycle();
    }, 60000);
};

/**
 * EEWアラートの表示サイクルを停止し、初期状態に戻す
 */
const stopEewDisplayCycle = () => {
    clearInterval(eewDisplayIntervalId);
    eewDisplayIntervalId = null; // タイマーIDをリセット
    clearTimeout(eewClearTimeoutId);
    eewQueue = [];
    document.getElementById('eew-alert-container').classList.add('hidden');
};


// --- データ取得と処理ロジック ---

/**
 * P2P地震情報APIからデータを取得し、最大震度3以上の地震にフィルタリングする
 * @returns {Promise<Array>} 処理された地震情報配列
 */
const fetchEarthquakeData = async () => {
    if (USE_DUMMY_DATA) {
        console.warn("★★★ 訓練モード有効 ★★★ ダミーデータを使用しています。テスト後は USE_DUMMY_DATA を false に戻してください。");
        const dummyData = [
            // --- 訓練用の大正関東大震災データ (code: 551) ---
        // --- 【新規追加】訓練用の緊急地震速報(EEW)データ (code: 554) ---
        {
            "code": 554,
            "issue": {
                "source": "気象庁",
                "time": "2025/12/25 12:00:00",
                "type": "ScalePrompt",
                "event_id": "20251225120000"
            },
            "earthquake": {
                "time": "2025-12-25T12:00:00+09:00",
                "hypocenter": {
                    "name": "東京湾",
                    "latitude": 35.5,
                    "longitude": 139.8,
                    "depth": 30,
                    "magnitude": 7.1
                },
                "maxScale": 60, // 震度6強
                "domesticTsunami": "Warning"
            }
        },
            {
                "code": 551,
                "issue": {
                    "source": "気象庁",
                    "time": "1923/09/01 11:59:00",
                    "type": "DetailScale",
                    "correct": "None",
                    "event_id": "19230901115800" // 津波情報と紐付けるID
                },
                "earthquake": {
                    "time": "1923-09-01T11:58:00+09:00",
                    "hypocenter": {
                        "name": "相模湾北西部",
                        "latitude": 35.1,
                        "longitude": 139.5,
                        "depth": 23,
                        "magnitude": 7.9
                    },
                    "maxScale": 70, // 震度7
                    "domesticTsunami": "Warning" // 津波警報
                },
                "points": [
                    { "pref": "神奈川県", "addr": "神奈川県横浜市", "scale": 70, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県小田原市", "scale": 70, "isArea": true },
                    { "pref": "東京都", "addr": "東京都千代田区", "scale": 60, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県館山市", "scale": 60, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県さいたま市", "scale": 55, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県甲府市", "scale": 55, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県御殿場市", "scale": 50, "isArea": true }
                ]
            },
            // --- 訓練用の大正関東大震災津波情報 (code: 552) ---
            {
                "code": 552,
                "issue": {
                    "source": "気象庁",
                    "time": "1923/09/01 12:01:00",
                    "type": "ScaleAndDestination",
                    "correct": "None",
                    "event_id": "19230901115800" // 地震情報と紐付けるID
                },
                "tsunami": {
                    "forecasts": [
                        { "grade": "Warning", "area": { "name": "相模湾・三浦半島" } },
                        { "grade": "Warning", "area": { "name": "静岡県" } },
                        { "grade": "Advisory", "area": { "name": "千葉県九十九里・外房" } },
                        { "grade": "Advisory", "area": { "name": "伊豆諸島" } }
                    ]
                }
            },
            // --- 【新規追加】訓練用の東日本大震災津波観測情報 (code: 556) ---
            {
                "code": 556,
                "cancelled": false,
                "issue": {
                    "source": "気象庁",
                    "time": "2011/03/11 15:30:00",
                    "type": "Tsunami",
                    "event_id": "20110311144600"
                },
                "areas": [
                    {
                        "grade": "MajorWarning",
                        "immediate": true,
                        "name": "宮城県",
                        "stations": [
                            { "name": "石巻市鮎川", "time": "2011-03-11T15:26:00+09:00", "height": 8.6, "condition": "観測中" },
                            { "name": "相馬", "time": "2011-03-11T15:20:00+09:00", "height": 9.3, "condition": "観測中" },
                            { "name": "大船渡", "time": "2011-03-11T15:18:00+09:00", "height": 8.0, "condition": "観測中" },
                            { "name": "釜石", "time": "2011-03-11T15:21:00+09:00", "height": 4.2, "condition": "観測中" }
                        ]
                    }
                ]
            },

            // --- 訓練用の十勝沖地震データ (code: 551) ---
            {
                "code": 551,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/03/20 10:02:00",
                    "type": "DetailScale",
                    "correct": "None",
                    "event_id": "20250320100000" // 津波情報と紐付けるID
                },
                "earthquake": {
                    "time": "2025-03-20T10:00:00+09:00",
                    "hypocenter": {
                        "name": "十勝沖",
                        "latitude": 42.5,
                        "longitude": 144.1,
                        "depth": 40,
                        "magnitude": 8.0
                    },
                    "maxScale": 60, // 震度6強
                    "domesticTsunami": "Warning" // 津波警報
                },
                "points": [
                    { "pref": "北海道", "addr": "北海道浦幌町", "scale": 60, "isArea": true },
                    { "pref": "北海道", "addr": "北海道釧路市", "scale": 55, "isArea": true },
                    { "pref": "北海道", "addr": "北海道帯広市", "scale": 55, "isArea": true },
                    { "pref": "青森県", "addr": "青森県八戸市", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県盛岡市", "scale": 50, "isArea": true },
                    { "pref": "北海道", "addr": "北海道札幌市中央区", "scale": 45, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県仙台市青葉区", "scale": 40, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県秋田市", "scale": 30, "isArea": true }
                ]
            },
            // --- 訓練用の十勝沖地震津波情報 (code: 552) ---
            {
                "code": 552,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/03/20 10:05:00",
                    "type": "ScaleAndDestination",
                    "correct": "None",
                    "event_id": "20250320100000" // 地震情報と紐付けるID
                },
                "tsunami": {
                    "forecasts": [
                        { "grade": "Warning", "area": { "name": "北海道太平洋沿岸東部" } },
                        { "grade": "Warning", "area": { "name": "北海道太平洋沿岸中部" } },
                        { "grade": "Advisory", "area": { "name": "北海道太平洋沿岸西部" } },
                        { "grade": "Advisory", "area": { "name": "青森県太平洋沿岸" } },
                        { "grade": "Advisory", "area": { "name": "岩手県" } },
                        { "grade": "Advisory", "area": { "name": "宮城県" } }
                    ]
                }
            },
            // --- 【新規追加】訓練用の南海トラフ地震EEWデータ (code: 554) ---
            {
                "code": 554,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/01/02 09:00:30",
                    "type": "ScalePrompt",
                    "event_id": "20250102090000"
                },
                "earthquake": {
                    "time": "2025-01-02T09:00:00+09:00",
                    "hypocenter": {
                        "name": "南海トラフ",
                        "latitude": 33.0,
                        "longitude": 135.0,
                        "depth": 30,
                        "magnitude": 9.1
                    },
                    "maxScale": 70, // 震度7
                    "domesticTsunami": "MajorWarning"
                }
            },
                                  // --- 訓練用の南海トラフ地震データ (code: 551) ---
            {
                "code": 551,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/01/02 09:02:00",
                    "type": "DetailScale",
                    "correct": "None",
                    "event_id": "20250102090000" // 津波情報と紐付けるID
                },
                "earthquake": {
                    "time": "2025-01-02T09:00:00+09:00",
                    "hypocenter": {
                        "name": "南海トラフ",
                        "latitude": 33.0,
                        "longitude": 135.0,
                        "depth": 30,
                        "magnitude": 9.1
                    },
                    "maxScale": 70, // 震度7
                    "domesticTsunami": "MajorWarning" // 大津波警報
                },
                "points": [
                    { "pref": "高知県", "addr": "高知県高知市", "scale": 70, "isArea": true },
                    { "pref": "徳島県", "addr": "徳島県徳島市", "scale": 70, "isArea": true },
                    { "pref": "和歌山県", "addr": "和歌山県和歌山市", "scale": 70, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県静岡市", "scale": 60, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県名古屋市", "scale": 60, "isArea": true },
                    { "pref": "三重県", "addr": "三重県津市", "scale": 60, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市", "scale": 60, "isArea": true },
                    { "pref": "兵庫県", "addr": "兵庫県神戸市", "scale": 60, "isArea": true },
                    { "pref": "香川県", "addr": "香川県高松市", "scale": 60, "isArea": true },
                    { "pref": "愛媛県", "addr": "愛媛県松山市", "scale": 60, "isArea": true },
                    { "pref": "大分県", "addr": "大分県大分市", "scale": 60, "isArea": true },
                    { "pref": "宮崎県", "addr": "宮崎県宮崎市", "scale": 60, "isArea": true },
                    { "pref": "奈良県", "addr": "奈良県奈良市", "scale": 55, "isArea": true },
                    { "pref": "京都府", "addr": "京都府京都市", "scale": 55, "isArea": true },
                    { "pref": "岡山県", "addr": "岡山県岡山市", "scale": 55, "isArea": true },
                    { "pref": "広島県", "addr": "広島県広島市", "scale": 55, "isArea": true },
                    { "pref": "山口県", "addr": "山口県山口市", "scale": 55, "isArea": true },
                    { "pref": "福岡県", "addr": "福岡県福岡市", "scale": 55, "isArea": true },
                    { "pref": "佐賀県", "addr": "佐賀県佐賀市", "scale": 55, "isArea": true },
                    { "pref": "熊本県", "addr": "熊本県熊本市", "scale": 55, "isArea": true },
                    { "pref": "鹿児島県", "addr": "鹿児島県鹿児島市", "scale": 55, "isArea": true },
                    { "pref": "東京都", "addr": "東京都千代田区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市", "scale": 50, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県大津市", "scale": 50, "isArea": true },
                    { "pref": "鳥取県", "addr": "鳥取県鳥取市", "scale": 50, "isArea": true },
                    { "pref": "島根県", "addr": "島根県松江市", "scale": 50, "isArea": true },
                    { "pref": "長崎県", "addr": "長崎県長崎市", "scale": 50, "isArea": true },
                    { "pref": "沖縄県", "addr": "沖縄県那覇市", "scale": 40, "isArea": true }
                ]
            },
            // --- 訓練用の南海トラフ津波情報 (code: 552) ---
            {
                "code": 552,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/01/02 09:05:00",
                    "type": "ScaleAndDestination",
                    "correct": "None",
                    "event_id": "20250102090000" // 地震情報と紐付けるID
                },
                "tsunami": {
                    "forecasts": [
                        { "grade": "MajorWarning", "area": { "name": "静岡県" } },
                        { "grade": "MajorWarning", "area": { "name": "愛知県外海" } },
                        { "grade": "MajorWarning", "area": { "name": "三重県南部" } },
                        { "grade": "MajorWarning", "area": { "name": "和歌山県" } },
                        { "grade": "MajorWarning", "area": { "name": "徳島県" } },
                        { "grade": "MajorWarning", "area": { "name": "高知県" } },
                        { "grade": "MajorWarning", "area": { "name": "宮崎県" } },
                        { "grade": "Warning", "area": { "name": "千葉県九十九里・外房" } },
                        { "grade": "Warning", "area": { "name": "神奈川県" } },
                        { "grade": "Warning", "area": { "name": "大阪府" } },
                        { "grade": "Warning", "area": { "name": "兵庫県瀬戸内海沿岸" } },
                        { "grade": "Warning", "area": { "name": "岡山県" } },
                        { "grade": "Warning", "area": { "name": "広島県" } },
                        { "grade": "Warning", "area": { "name": "山口県瀬戸内海沿岸" } },
                        { "grade": "Warning", "area": { "name": "大分県" } },
                        { "grade": "Warning", "area": { "name": "鹿児島県東部" } },
                        { "grade": "Advisory", "area": { "name": "東京都伊豆諸島" } },
                        { "grade": "Advisory", "area": { "name": "東京都小笠原諸島" } },
                        { "grade": "Advisory", "area": { "name": "愛知県内海" } },
                        { "grade": "Advisory", "area": { "name": "瀬戸内海沿岸" } },
                        { "grade": "Advisory", "area": { "name": "九州西岸" } },
                        { "grade": "Advisory", "area": { "name": "沖縄本島地方" } }
                    ]
                }
            },
            // --- 訓練用の香川県東部地震データ (code: 551) ---
            {
                "code": 551,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/11/07 15:05:00",
                    "type": "DetailScale",
                    "correct": "None",
                    "event_id": "20251107150000" // 津波情報と紐付けるID
                },
                "earthquake": {
                    "time": "2025-11-07T15:00:00+09:00",
                    "hypocenter": {
                        "name": "香川県東部",
                        "latitude": 34.3,
                        "longitude": 134.2,
                        "depth": 10,
                        "magnitude": 7.0
                    },
                    "maxScale": 60, // 震度6強
                    "domesticTsunami": "None" // 津波なし
                },
                "points": [
                    { "pref": "香川県", "addr": "香川県高松市", "scale": 60, "isArea": true },
                    { "pref": "香川県", "addr": "香川県さぬき市", "scale": 55, "isArea": true },
                    { "pref": "香川県", "addr": "香川県丸亀市", "scale": 50, "isArea": true },
                    { "pref": "徳島県", "addr": "徳島県徳島市", "scale": 45, "isArea": true },
                    { "pref": "岡山県", "addr": "岡山県岡山市", "scale": 40, "isArea": true },
                    { "pref": "愛媛県", "addr": "愛媛県松山市", "scale": 30, "isArea": true }
                ]
            },
            // --- 訓練用の大阪府北部（上町断層帯）地震データ (code: 551) ---
            {
                "code": 551,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/01/03 14:32:00",
                    "type": "DetailScale",
                    "correct": "None",
                    "event_id": "20250103143000"
                },
                "earthquake": {
                    "time": "2025-01-03T14:30:00+09:00",
                    "hypocenter": {
                        "name": "大阪府北部",
                        "latitude": 34.7,
                        "longitude": 135.5,
                        "depth": 10,
                        "magnitude": 7.5
                    },
                    "maxScale": 70,
                    "domesticTsunami": "None"
                },
                "points": [
                    { "pref": "大阪府", "addr": "大阪府大阪市中央区", "scale": 70, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市北区", "scale": 70, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府堺市堺区", "scale": 60, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府豊中市", "scale": 60, "isArea": true },
                    { "pref": "兵庫県", "addr": "兵庫県尼崎市", "scale": 60, "isArea": true },
                    { "pref": "京都府", "addr": "京都府京都市伏見区", "scale": 55, "isArea": true },
                    { "pref": "奈良県", "addr": "奈良県奈良市", "scale": 55, "isArea": true },
                    { "pref": "和歌山県", "addr": "和歌山県和歌山市", "scale": 55, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県大津市", "scale": 55, "isArea": true },
                    { "pref": "兵庫県", "addr": "兵庫県神戸市東灘区", "scale": 50, "isArea": true },
                    { "pref": "三重県", "addr": "三重県津市", "scale": 50, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県岐阜市", "scale": 45, "isArea": true },
                    { "pref": "福井県", "addr": "福井県福井市", "scale": 45, "isArea": true },
                    { "pref": "徳島県", "addr": "徳島県徳島市", "scale": 40, "isArea": true }
                ]
            },
            // --- 訓練用の津波情報 (code: 552) ---
            {
                "code": 552,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/01/01 12:05:00",
                    "type": "ScaleAndDestination",
                    "correct": "None",
                    "event_id": "20250101120000" // 地震情報と紐付けるID
                },
                "tsunami": {
                    "forecasts": [
                        // 大津波警報
                        { "grade": "MajorWarning", "area": { "name": "石川県能登" } },
                        { "grade": "MajorWarning", "area": { "name": "新潟県上中下越" } },
                        // 津波警報
                        { "grade": "Warning", "area": { "name": "山形県" } },
                        { "grade": "Warning", "area": { "name": "兵庫県北部" } },
                        { "grade": "Warning", "area": { "name": "北海道日本海沿岸南部" } },
                        // 津波注意報
                        { "grade": "Advisory", "area": { "name": "京都府" } },
                        { "grade": "Advisory", "area": { "name": "福井県" } },
                        { "grade": "Advisory", "area": { "name": "鳥取県" } },
                        { "grade": "Advisory", "area": { "name": "島根県出雲・石見" } },
                        { "grade": "Advisory", "area": { "name": "福岡県日本海沿岸" } },
                        { "grade": "Advisory", "area": { "name": "佐賀県北部" } },
                        { "grade": "Advisory", "area": { "name": "長崎県壱岐・対馬" } },
                    ]
                }
            },
            // --- 【新規追加】訓練用の東日本大震災EEWデータ (code: 554) ---
            {
                "code": 554,
                "issue": {
                    "source": "気象庁",
                    "time": "2011/03/11 14:46:30",
                    "type": "ScalePrompt",
                    "event_id": "20110311144600"
                },
                "earthquake": {
                    "time": "2011-03-11T14:46:00+09:00",
                    "hypocenter": {
                        "name": "三陸沖",
                        "latitude": 38.1,
                        "longitude": 142.9,
                        "depth": 24,
                        "magnitude": 9.0
                    },
                    "maxScale": 70, // 震度7
                    "domesticTsunami": "MajorWarning"
                }
            },
            // --- 訓練用の震源・震度情報 (code: 551) ---
            {
                "code": 551,
                "issue": {
                    "source": "気象庁",
                    "time": "2011/03/11 14:49:00",
                    "type": "ScaleAndDestination",
                    "correct": "None",
                    "event_id": "20110311144600"
                },
                "earthquake": {
                    "time": "2011-03-11T14:46:00+09:00",
                    "hypocenter": {
                        "name": "三陸沖",
                        "latitude": 38.1,
                        "longitude": 142.9,
                        "depth": 24,
                        "magnitude": 9.0
                    },
                    "maxScale": 70, // 震度7
                    "domesticTsunami": "MajorWarning" // 大津波警報
                },
                "points": [
                    // 震度7
                    { "pref": "宮城県", "addr": "宮城県栗原市", "scale": 70, "isArea": true },
                    // 震度6強
                    { "pref": "宮城県", "addr": "宮城県登米市", "scale": 60, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県大崎市", "scale": 60, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県名取市", "scale": 60, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県刈田郡蔵王町", "scale": 60, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県仙台市宮城野区", "scale": 60, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県石巻市", "scale": 60, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県塩竈市", "scale": 60, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県東松島市", "scale": 60, "isArea": true },
                    { "pref": "福島県", "addr": "福島県白河市", "scale": 60, "isArea": true },
                    { "pref": "福島県", "addr": "福島県須賀川市", "scale": 60, "isArea": true },
                    { "pref": "福島県", "addr": "福島県伊達郡国見町", "scale": 60, "isArea": true },
                    { "pref": "福島県", "addr": "福島県岩瀬郡鏡石町", "scale": 60, "isArea": true },
                    { "pref": "福島県", "addr": "福島県双葉郡楢葉町", "scale": 60, "isArea": true },
                    { "pref": "福島県", "addr": "福島県双葉郡富岡町", "scale": 60, "isArea": true },
                    { "pref": "福島県", "addr": "福島県双葉郡大熊町", "scale": 60, "isArea": true },
                    { "pref": "福島県", "addr": "福島県双葉郡双葉町", "scale": 60, "isArea": true },
                    { "pref": "福島県", "addr": "福島県双葉郡浪江町", "scale": 60, "isArea": true },
                    { "pref": "福島県", "addr": "福島県相馬郡新地町", "scale": 60, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県日立市", "scale": 60, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県高萩市", "scale": 60, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県笠間市", "scale": 60, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県筑西市", "scale": 60, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県常陸大宮市", "scale": 60, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県那珂市", "scale": 60, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県鉾田市", "scale": 60, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県大田原市", "scale": 60, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県宇都宮市", "scale": 60, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県真岡市", "scale": 60, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県芳賀郡市貝町", "scale": 60, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県塩谷郡高根沢町", "scale": 60, "isArea": true },
                    // 震度6弱
                    { "pref": "岩手県", "addr": "岩手県大船渡市", "scale": 55, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県釜石市", "scale": 55, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県滝沢市", "scale": 55, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県紫波郡矢巾町", "scale": 55, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県一関市", "scale": 55, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県気仙沼市", "scale": 55, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県白石市", "scale": 55, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県角田市", "scale": 55, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県岩沼市", "scale": 55, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県仙台市青葉区", "scale": 55, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県仙台市若林区", "scale": 55, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県仙台市泉区", "scale": 55, "isArea": true },
                    { "pref": "福島県", "addr": "福島県福島市", "scale": 55, "isArea": true },
                    { "pref": "福島県", "addr": "福島県郡山市", "scale": 55, "isArea": true },
                    { "pref": "福島県", "addr": "福島県いわき市", "scale": 55, "isArea": true },
                    { "pref": "福島県", "addr": "福島県相馬市", "scale": 55, "isArea": true },
                    { "pref": "福島県", "addr": "福島県南相馬市", "scale": 55, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県水戸市", "scale": 55, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県土浦市", "scale": 55, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県石岡市", "scale": 55, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県つくば市", "scale": 55, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県行方市", "scale": 55, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県那須塩原市", "scale": 55, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県那須烏山市", "scale": 55, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県桐生市", "scale": 55, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県渋川市", "scale": 55, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県加須市", "scale": 55, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県久喜市", "scale": 55, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県さいたま市浦和区", "scale": 55, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県旭市", "scale": 55, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県香取市", "scale": 55, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県浦安市", "scale": 55, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県印西市", "scale": 55, "isArea": true },
                    { "pref": "東京都", "addr": "東京都江東区", "scale": 55, "isArea": true },
                    // --- 震度5強 (全地点追加) ---
                    { "pref": "青森県", "addr": "青森県八戸市", "scale": 50, "isArea": true },
                    { "pref": "青森県", "addr": "青森県十和田市", "scale": 50, "isArea": true },
                    { "pref": "青森県", "addr": "青森県三沢市", "scale": 50, "isArea": true },
                    { "pref": "青森県", "addr": "青森県上北郡野辺地町", "scale": 50, "isArea": true },
                    { "pref": "青森県", "addr": "青森県上北郡七戸町", "scale": 50, "isArea": true },
                    { "pref": "青森県", "addr": "青森県上北郡六戸町", "scale": 50, "isArea": true },
                    { "pref": "青森県", "addr": "青森県上北郡東北町", "scale": 50, "isArea": true },
                    { "pref": "青森県", "addr": "青森県上北郡おいらせ町", "scale": 50, "isArea": true },
                    { "pref": "青森県", "addr": "青森県三戸郡五戸町", "scale": 50, "isArea": true },
                    { "pref": "青森県", "addr": "青森県三戸郡階上町", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県盛岡市", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県宮古市", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県花巻市", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県北上市", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県遠野市", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県奥州市", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県紫波郡紫波町", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県胆沢郡金ケ崎町", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県西磐井郡平泉町", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県気仙郡住田町", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県下閉伊郡山田町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県加美郡加美町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県加美郡色麻町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県遠田郡涌谷町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県遠田郡美里町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県柴田郡大河原町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県柴田郡村田町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県柴田郡柴田町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県柴田郡川崎町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県伊具郡丸森町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県亘理郡亘理町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県亘理郡山元町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県多賀城市", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県宮城郡松島町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県宮城郡七ヶ浜町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県宮城郡利府町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県黒川郡大郷町", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県黒川郡大衡村", "scale": 50, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県本吉郡南三陸町", "scale": 50, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県横手市", "scale": 50, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県大仙市", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県上山市", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県村山市", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県天童市", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県東根市", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県西村山郡河北町", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県西村山郡大江町", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県尾花沢市", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県米沢市", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県南陽市", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県東置賜郡高畠町", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県東置賜郡川西町", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県西置賜郡白鷹町", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県東村山郡山辺町", "scale": 50, "isArea": true },
                    { "pref": "山形県", "addr": "山形県東村山郡中山町", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県二本松市", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県田村市", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県伊達市", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県本宮市", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県伊達郡桑折町", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県伊達郡川俣町", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県安達郡大玉村", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県岩瀬郡天栄村", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県西白河郡泉崎村", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県西白河郡中島村", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県西白河郡矢吹町", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県東白川郡棚倉町", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県石川郡玉川村", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県石川郡浅川町", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県田村郡小野町", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県双葉郡広野町", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県双葉郡川内村", "scale": 50, "isArea": true },
                    { "pref": "福島県", "addr": "福島県相馬郡飯舘村", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県常陸太田市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県北茨城市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県ひたちなか市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県常陸大宮市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県小美玉市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県東茨城郡城里町", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県那珂郡東海村", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県結城市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県下妻市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県常総市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県取手市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県牛久市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県つくばみらい市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県坂東市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県稲敷市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県かすみがうら市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県桜川市", "scale": 50, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県神栖市", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県日光市", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県矢板市", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県塩谷郡塩谷町", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県那須郡那須町", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県那須郡那珂川町", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県鹿沼市", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県小山市", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県河内郡上三川町", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県芳賀郡益子町", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県芳賀郡茂木町", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県芳賀郡芳賀町", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県下都賀郡壬生町", "scale": 50, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県下都賀郡野木町", "scale": 50, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県沼田市", "scale": 50, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県前橋市", "scale": 50, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県高崎市", "scale": 50, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県伊勢崎市", "scale": 50, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県太田市", "scale": 50, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県館林市", "scale": 50, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県安中市", "scale": 50, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県みどり市", "scale": 50, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県北群馬郡吉岡町", "scale": 50, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県吾妻郡東吾妻町", "scale": 50, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県邑楽郡邑楽町", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県熊谷市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県行田市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県本庄市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県東松山市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県羽生市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県鴻巣市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県深谷市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県比企郡滑川町", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県比企郡嵐山町", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県比企郡吉見町", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県児玉郡美里町", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県さいたま市西区", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県さいたま市北区", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県さいたま市大宮区", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県さいたま市見沼区", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県さいたま市中央区", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県さいたま市桜区", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県さいたま市南区", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県さいたま市緑区", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県さいたま市岩槻区", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県川越市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県川口市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県春日部市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県狭山市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県草加市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県越谷市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県蕨市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県戸田市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県入間市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県朝霞市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県志木市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県和光市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県新座市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県桶川市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県北本市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県八潮市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県富士見市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県三郷市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県蓮田市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県幸手市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県吉川市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県白岡市", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県北足立郡伊奈町", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県入間郡三芳町", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県比企郡川島町", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県南埼玉郡宮代町", "scale": 50, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県北葛飾郡杉戸町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県千葉市中央区", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県千葉市花見川区", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県千葉市稲毛区", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県千葉市若葉区", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県千葉市緑区", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県千葉市美浜区", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県銚子市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県市川市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県船橋市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県館山市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県木更津市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県松戸市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県野田市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県茂原市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県成田市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県佐倉市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県東金市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県習志野市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県柏市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県市原市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県流山市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県八千代市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県我孫子市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県鎌ケ谷市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県君津市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県富津市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県四街道市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県八街市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県白井市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県富里市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県匝瑳市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県山武市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県いすみ市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県大網白里市", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県印旛郡酒々井町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県印旛郡栄町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県香取郡多古町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県山武郡九十九里町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県山武郡芝山町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県山武郡横芝光町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県長生郡一宮町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県長生郡睦沢町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県長生郡長生村", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県長生郡白子町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県長生郡長柄町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県長生郡長南町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県夷隅郡大多喜町", "scale": 50, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県安房郡鋸南町", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都千代田区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都中央区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都港区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都新宿区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都文京区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都台東区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都墨田区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都品川区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都目黒区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都大田区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都世田谷区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都渋谷区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都中野区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都杉並区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都豊島区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都北区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都荒川区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都板橋区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都練馬区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都足立区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都葛飾区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都江戸川区", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都調布市", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都町田市", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都小平市", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都日野市", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都東村山市", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都国分寺市", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都狛江市", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都東大和市", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都清瀬市", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都武蔵村山市", "scale": 50, "isArea": true },
                    { "pref": "東京都", "addr": "東京都西東京市", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市鶴見区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市神奈川区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市西区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市中区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市南区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市保土ケ谷区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市磯子区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市港北区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市戸塚区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市港南区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市旭区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市緑区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市瀬谷区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市栄区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市泉区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市青葉区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市都筑区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県川崎市川崎区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県川崎市幸区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県川崎市中原区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県川崎市高津区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県川崎市多摩区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県川崎市宮前区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県川崎市麻生区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県相模原市緑区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県相模原市中央区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県相模原市南区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県厚木市", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県大和市", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県海老名市", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県座間市", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県綾瀬市", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県高座郡寒川町", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県愛甲郡愛川町", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県愛甲郡清川村", "scale": 50, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県見附市", "scale": 50, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県刈羽郡刈羽村", "scale": 50, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県東蒲原郡阿賀町", "scale": 50, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県南魚沼市", "scale": 50, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県甲府市", "scale": 50, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県富士吉田市", "scale": 50, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県都留市", "scale": 50, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県大月市", "scale": 50, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県上野原市", "scale": 50, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県甲州市", "scale": 50, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県笛吹市", "scale": 50, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県西八代郡市川三郷町", "scale": 50, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県南巨摩郡富士川町", "scale": 50, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県南都留郡忍野村", "scale": 50, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県南都留郡富士河口湖町", "scale": 50, "isArea": true },
                    { "pref": "長野県", "addr": "長野県諏訪市", "scale": 50, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県富士宮市", "scale": 50, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県賀茂郡東伊豆町", "scale": 50, "isArea": true },
                    // --- 震度5弱 (全地点追加) ---
                    { "pref": "北海道", "addr": "北海道函館市", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道石狩郡新篠津村", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道空知郡南幌町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道夕張郡由仁町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道夕張郡栗山町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道北斗市", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道日高郡新ひだか町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道浦河郡浦河町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道様似郡様似町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道幌泉郡えりも町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道勇払郡安平町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道勇払郡むかわ町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道沙流郡日高町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道沙流郡平取町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道新冠郡新冠町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道帯広市", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道河東郡音更町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道河西郡芽室町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道河西郡更別村", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道中川郡幕別町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道中川郡池田町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道中川郡豊頃町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道中川郡本別町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道十勝郡浦幌町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道釧路市", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道厚岸郡厚岸町", "scale": 45, "isArea": true },
                    { "pref": "北海道", "addr": "北海道白糠郡白糠町", "scale": 45, "isArea": true },
                    { "pref": "青森県", "addr": "青森県青森市", "scale": 45, "isArea": true },
                    { "pref": "青森県", "addr": "青森県東津軽郡平内町", "scale": 45, "isArea": true },
                    { "pref": "青森県", "addr": "青森県むつ市", "scale": 45, "isArea": true },
                    { "pref": "青森県", "addr": "青森県下北郡東通村", "scale": 45, "isArea": true },
                    { "pref": "青森県", "addr": "青森県上北郡六ヶ所村", "scale": 45, "isArea": true },
                    { "pref": "青森県", "addr": "青森県三戸郡三戸町", "scale": 45, "isArea": true },
                    { "pref": "青森県", "addr": "青森県三戸郡田子町", "scale": 45, "isArea": true },
                    { "pref": "青森県", "addr": "青森県三戸郡南部町", "scale": 45, "isArea": true },
                    { "pref": "青森県", "addr": "青森県つがる市", "scale": 45, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県久慈市", "scale": 45, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県二戸市", "scale": 45, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県八幡平市", "scale": 45, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県岩手郡葛巻町", "scale": 45, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県岩手郡岩手町", "scale": 45, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県和賀郡西和賀町", "scale": 45, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県下閉伊郡普代村", "scale": 45, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県九戸郡野田村", "scale": 45, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県二戸郡一戸町", "scale": 45, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県牡鹿郡女川町", "scale": 45, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県秋田市", "scale": 45, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県能代市", "scale": 45, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県湯沢市", "scale": 45, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県由利本荘市", "scale": 45, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県潟上市", "scale": 45, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県にかほ市", "scale": 45, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県山本郡三種町", "scale": 45, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県南秋田郡井川町", "scale": 45, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県雄勝郡羽後町", "scale": 45, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県雄勝郡東成瀬村", "scale": 45, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県仙北郡美郷町", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県山形市", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県寒河江市", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県上山市", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県西村山郡西川町", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県西村山郡朝日町", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県北村山郡大石田町", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県新庄市", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県最上郡最上町", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県最上郡舟形町", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県最上郡真室川町", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県最上郡大蔵村", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県最上郡鮭川村", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県最上郡戸沢村", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県長井市", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県西置賜郡飯豊町", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県酒田市", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県東田川郡三川町", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県東田川郡庄内町", "scale": 45, "isArea": true },
                    { "pref": "山形県", "addr": "山形県飽海郡遊佐町", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県会津若松市", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県喜多方市", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県耶麻郡西会津町", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県耶麻郡磐梯町", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県耶麻郡猪苗代町", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県河沼郡会津坂下町", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県河沼郡湯川村", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県大沼郡会津美里町", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県西白河郡西郷村", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県東白川郡矢祭町", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県東白川郡塙町", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県東白川郡鮫川村", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県石川郡石川町", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県石川郡平田村", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県石川郡古殿町", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県田村郡三春町", "scale": 45, "isArea": true },
                    { "pref": "福島県", "addr": "福島県双葉郡葛尾村", "scale": 45, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県久慈郡大子町", "scale": 45, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県龍ケ崎市", "scale": 45, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県守谷市", "scale": 45, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県筑西市", "scale": 45, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県稲敷郡阿見町", "scale": 45, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県稲敷郡河内町", "scale": 45, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県結城郡八千代町", "scale": 45, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県猿島郡五霞町", "scale": 45, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県猿島郡境町", "scale": 45, "isArea": true },
                    { "pref": "茨城県", "addr": "茨城県北相馬郡利根町", "scale": 45, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県足利市", "scale": 45, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県栃木市", "scale": 45, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県佐野市", "scale": 45, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木県下野市", "scale": 45, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県利根郡片品村", "scale": 45, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県吾妻郡中之条町", "scale": 45, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県北群馬郡榛東村", "scale": 45, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県甘楽郡甘楽町", "scale": 45, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県佐波郡玉村町", "scale": 45, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県邑楽郡板倉町", "scale": 45, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県邑楽郡明和町", "scale": 45, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県邑楽郡千代田町", "scale": 45, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県邑楽郡大泉町", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県秩父市", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県所沢市", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県飯能市", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県加須市", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県上尾市", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県ふじみ野市", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県坂戸市", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県鶴ヶ島市", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県日高市", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県入間郡毛呂山町", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県入間郡越生町", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県比企郡小川町", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県比企郡鳩山町", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県比企郡ときがわ町", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県秩父郡横瀬町", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県秩父郡皆野町", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県秩父郡長瀞町", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県秩父郡小鹿野町", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県秩父郡東秩父村", "scale": 45, "isArea": true },
                    { "pref": "埼玉県", "addr": "埼玉県北葛飾郡松伏町", "scale": 45, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県香取郡神崎町", "scale": 45, "isArea": true },
                    { "pref": "千葉県", "addr": "千葉県袖ケ浦市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都八王子市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都立川市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都武蔵野市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都三鷹市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都青梅市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都府中市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都昭島市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都小金井市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都国立市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都福生市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都東久留米市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都多摩市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都稲城市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都羽村市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都あきる野市", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都西多摩郡瑞穂町", "scale": 45, "isArea": true },
                    { "pref": "東京都", "addr": "東京都西多摩郡日の出町", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県平塚市", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県藤沢市", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県小田原市", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県茅ヶ崎市", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県逗子市", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県三浦市", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県秦野市", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県伊勢原市", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県南足柄市", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県三浦郡葉山町", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県中郡二宮町", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県中郡中井町", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県足柄上郡大井町", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県足柄上郡松田町", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県足柄上郡山北町", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県足柄上郡開成町", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県足柄下郡箱根町", "scale": 45, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県足柄下郡湯河原町", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟市北区", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟市東区", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟市中央区", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟市江南区", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟市秋葉区", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟市南区", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟市西区", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県長岡市", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県三条市", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県柏崎市", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県加茂市", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県十日町市", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県五泉市", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県燕市", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県魚沼市", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県西蒲原郡弥彦村", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県南蒲原郡田上町", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県三島郡出雲崎町", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県中魚沼郡津南町", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県阿賀野市", "scale": 45, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県佐渡市", "scale": 45, "isArea": true },
                    { "pref": "富山県", "addr": "富山県滑川市", "scale": 45, "isArea": true },
                    { "pref": "富山県", "addr": "富山県中新川郡舟橋村", "scale": 45, "isArea": true },
                    { "pref": "富山県", "addr": "富山県中新川郡上市町", "scale": 45, "isArea": true },
                    { "pref": "富山県", "addr": "富山県中新川郡立山町", "scale": 45, "isArea": true },
                    { "pref": "富山県", "addr": "富山県氷見市", "scale": 45, "isArea": true },
                    { "pref": "石川県", "addr": "石川県七尾市", "scale": 45, "isArea": true },
                    { "pref": "石川県", "addr": "石川県加賀市", "scale": 45, "isArea": true },
                    { "pref": "石川県", "addr": "石川県能美市", "scale": 45, "isArea": true },
                    { "pref": "石川県", "addr": "石川県鳳珠郡穴水町", "scale": 45, "isArea": true },
                    { "pref": "石川県", "addr": "石川県鳳珠郡能登町", "scale": 45, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県南アルプス市", "scale": 45, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県中央市", "scale": 45, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県中巨摩郡昭和町", "scale": 45, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県南巨摩郡身延町", "scale": 45, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県南巨摩郡南部町", "scale": 45, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県南都留郡山中湖村", "scale": 45, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県南都留郡鳴沢村", "scale": 45, "isArea": true },
                    { "pref": "長野県", "addr": "長野県長野市", "scale": 45, "isArea": true },
                    { "pref": "長野県", "addr": "長野県飯田市", "scale": 45, "isArea": true },
                    { "pref": "長野県", "addr": "長野県小諸市", "scale": 45, "isArea": true },
                    { "pref": "長野県", "addr": "長野県佐久市", "scale": 45, "isArea": true },
                    { "pref": "長野県", "addr": "長野県茅野市", "scale": 45, "isArea": true },
                    { "pref": "長野県", "addr": "長野県北佐久郡軽井沢町", "scale": 45, "isArea": true },
                    { "pref": "長野県", "addr": "長野県北佐久郡御代田町", "scale": 45, "isArea": true },
                    { "pref": "長野県", "addr": "長野県南佐久郡佐久穂町", "scale": 45, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上水内郡飯綱町", "scale": 45, "isArea": true },
                    { "pref": "長野県", "addr": "長野県下水内郡栄村", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県静岡市駿河区", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県沼津市", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県三島市", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県富士市", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県御殿場市", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県裾野市", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県伊豆市", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県伊豆の国市", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県田方郡函南町", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県駿東郡清水町", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県駿東郡長泉町", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県駿東郡小山町", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県賀茂郡河津町", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県賀茂郡西伊豆町", "scale": 45, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県牧之原市", "scale": 45, "isArea": true },
                    // 震度4
                    { "pref": "北海道", "addr": "北海道札幌市北区", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道札幌市東区", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道札幌市白石区", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道札幌市豊平区", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道札幌市手稲区", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道江別市", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道千歳市", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道恵庭市", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道夕張郡長沼町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道亀田郡七飯町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道茅部郡鹿部町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道茅部郡森町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道松前郡松前町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上磯郡知内町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上磯郡木古内町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道爾志郡乙部町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道久遠郡せたな町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道瀬棚郡今金町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道岩見沢市", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道美唄市", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道三笠市", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道樺戸郡月形町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道樺戸郡浦臼町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道苫小牧市", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道白老郡白老町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道勇払郡厚真町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道虻田郡豊浦町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道虻田郡洞爺湖町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道河東郡士幌町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道河東郡上士幌町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道河東郡鹿追町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡新得町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡清水町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道河西郡中札内村", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道広尾郡大樹町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道広尾郡広尾町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道足寄郡足寄町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道足寄郡陸別町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道釧路郡釧路町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道厚岸郡浜中町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道川上郡標茶町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道川上郡弟子屈町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道阿寒郡鶴居村", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道根室市", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道野付郡別海町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道標津郡中標津町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道標津郡標津町", "scale": 40, "isArea": true },
                    { "pref": "北海道", "addr": "北海道目梨郡羅臼町", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県東津軽郡外ヶ浜町", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県東津軽郡今別町", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県東津軽郡蓬田村", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県上北郡横浜町", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県下北郡大間町", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県下北郡風間浦村", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県下北郡佐井村", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県弘前市", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県黒石市", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県五所川原市", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県平川市", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県西津軽郡板柳町", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県北津軽郡鶴田町", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県北津軽郡中泊町", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県南津軽郡藤崎町", "scale": 40, "isArea": true },
                    { "pref": "青森県", "addr": "青森県南津軽郡田舎館村", "scale": 40, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県九戸郡洋野町", "scale": 40, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県二戸郡軽米町", "scale": 40, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県九戸郡九戸村", "scale": 40, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県大館市", "scale": 40, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県鹿角市", "scale": 40, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県北秋田市", "scale": 40, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県鹿角郡小坂町", "scale": 40, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県北秋田郡上小阿仁村", "scale": 40, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県男鹿市", "scale": 40, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県南秋田郡五城目町", "scale": 40, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県南秋田郡八郎潟町", "scale": 40, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県南秋田郡大潟村", "scale": 40, "isArea": true },
                    { "pref": "山形県", "addr": "山形県鶴岡市", "scale": 40, "isArea": true },
                    { "pref": "栃木県", "addr": "栃木市入舟町", "scale": 40, "isArea": true },
                    { "pref": "栃木県", "addr": "佐野市中町", "scale": 40, "isArea": true },
                    { "pref": "栃木県", "addr": "日光市足尾町中才", "scale": 40, "isArea": true },
                    { "pref": "栃木県", "addr": "日光市日蔭", "scale": 40, "isArea": true },
                    { "pref": "栃木県", "addr": "日光市藤原", "scale": 40, "isArea": true },
                    { "pref": "栃木県", "addr": "日光市中宮祠", "scale": 40, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県吾妻郡長野原町", "scale": 40, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県吾妻郡草津町", "scale": 40, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県吾妻郡嬬恋村", "scale": 40, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県利根郡高山村", "scale": 40, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県吾妻郡東吾妻町", "scale": 40, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県利根郡片品村", "scale": 40, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県利根郡川場村", "scale": 40, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県利根郡昭和村", "scale": 40, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県利根郡みなかみ町", "scale": 40, "isArea": true },
                    { "pref": "東京都", "addr": "東京都大島町", "scale": 40, "isArea": true },
                    { "pref": "東京都", "addr": "東京都利島村", "scale": 40, "isArea": true },
                    { "pref": "東京都", "addr": "東京都新島村", "scale": 40, "isArea": true },
                    { "pref": "東京都", "addr": "東京都三宅村", "scale": 40, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟市西蒲区", "scale": 40, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県新発田市", "scale": 40, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県村上市", "scale": 40, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県北蒲原郡聖籠町", "scale": 40, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県岩船郡関川村", "scale": 40, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県岩船郡粟島浦村", "scale": 40, "isArea": true },
                    { "pref": "富山県", "addr": "富山県富山市", "scale": 40, "isArea": true },
                    { "pref": "富山県", "addr": "富山県高岡市", "scale": 40, "isArea": true },
                    { "pref": "富山県", "addr": "富山県魚津市", "scale": 40, "isArea": true },
                    { "pref": "富山県", "addr": "富山県小矢部市", "scale": 40, "isArea": true },
                    { "pref": "富山県", "addr": "富山県南砺市", "scale": 40, "isArea": true },
                    { "pref": "富山県", "addr": "富山県射水市", "scale": 40, "isArea": true },
                    { "pref": "富山県", "addr": "富山県下新川郡朝日町", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県金沢市", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県小松市", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県輪島市", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県珠洲市", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県羽咋市", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県かほく市", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県白山市", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県河北郡津幡町", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県河北郡内灘町", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県羽咋郡志賀町", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県羽咋郡宝達志水町", "scale": 40, "isArea": true },
                    { "pref": "石川県", "addr": "石川県鹿島郡中能登町", "scale": 40, "isArea": true },
                    { "pref": "福井県", "addr": "福井県福井市", "scale": 40, "isArea": true },
                    { "pref": "福井県", "addr": "福井県敦賀市", "scale": 40, "isArea": true },
                    { "pref": "福井県", "addr": "福井県越前市", "scale": 40, "isArea": true },
                    { "pref": "福井県", "addr": "福井県あわら市", "scale": 40, "isArea": true },
                    { "pref": "福井県", "addr": "福井県坂井市", "scale": 40, "isArea": true },
                    { "pref": "福井県", "addr": "福井県吉田郡永平寺町", "scale": 40, "isArea": true },
                    { "pref": "福井県", "addr": "福井県丹生郡越前町", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上田市", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県岡谷市", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県飯山市", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県中野市", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県大町市", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県千曲市", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県東御市", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県北佐久郡立科町", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県小県郡長和町", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県諏訪郡下諏訪町", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県小県郡青木村", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県埴科郡坂城町", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上高井郡小布施町", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県下高井郡山ノ内町", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上水内郡信濃町", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上水内郡小川村", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県下高井郡野沢温泉村", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県下高井郡木島平村", "scale": 40, "isArea": true },
                    { "pref": "長野県", "addr": "長野県南佐久郡南牧村", "scale": 40, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県高山市", "scale": 40, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県中津川市", "scale": 40, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県飛騨市", "scale": 40, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県大野郡白川村", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡市葵区", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡市清水区", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県熱海市", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県伊東市", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県掛川市", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県袋井市", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県湖西市", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県御前崎市", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県菊川市", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県賀茂郡松崎町", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県賀茂郡南伊豆町", "scale": 40, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県周智郡森町", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県名古屋市港区", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県名古屋市南区", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県豊橋市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県豊川市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県刈谷市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県豊田市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県安城市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県西尾市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県蒲郡市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県常滑市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県稲沢市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県新城市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県東海市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県大府市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県知多市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県知立市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県高浜市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県田原市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県愛西市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県弥富市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県みよし市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県あま市", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県愛知郡東郷町", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県西春日井郡大治町", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県海部郡蟹江町", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県海部郡飛島村", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県知多郡阿久比町", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県知多郡東浦町", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県知多郡南知多町", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県知多郡美浜町", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県知多郡武豊町", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県額田郡幸田町", "scale": 40, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県北設楽郡設楽町", "scale": 40, "isArea": true },
                    { "pref": "三重県", "addr": "三重県四日市市", "scale": 40, "isArea": true },
                    { "pref": "三重県", "addr": "三重県桑名市", "scale": 40, "isArea": true },
                    { "pref": "三重県", "addr": "三重県鈴鹿市", "scale": 40, "isArea": true },
                    { "pref": "三重県", "addr": "三重県亀山市", "scale": 40, "isArea": true },
                    { "pref": "三重県", "addr": "三重県いなべ市", "scale": 40, "isArea": true },
                    { "pref": "三重県", "addr": "三重県桑名郡木曽岬町", "scale": 40, "isArea": true },
                    { "pref": "三重県", "addr": "三重県員弁郡東員町", "scale": 40, "isArea": true },
                    { "pref": "三重県", "addr": "三重県三重郡朝日町", "scale": 40, "isArea": true },
                    { "pref": "三重県", "addr": "三重県三重郡川越町", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県彦根市", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県長浜市", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県近江八幡市", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県草津市", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県栗東市", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県甲賀市", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県野洲市", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県湖南市", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県東近江市", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県米原市", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県蒲生郡日野町", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県蒲生郡竜王町", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県愛知郡愛荘町", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県犬上郡多賀町", "scale": 40, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県大津市", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府京都市中京区", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府京都市右京区", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府京都市伏見区", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府京都市西京区", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府宇治市", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府亀岡市", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府城陽市", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府向日市", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府長岡京市", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府八幡市", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府京田辺市", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府南丹市", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府乙訓郡大山崎町", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府久世郡久御山町", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府綴喜郡井手町", "scale": 40, "isArea": true },
                    { "pref": "京都府", "addr": "京都府相楽郡精華町", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市港区", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市大正区", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市西淀川区", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市東淀川区", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市旭区", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市城東区", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市鶴見区", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市住之江区", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市平野区", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市北区", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府豊中市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府池田市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府吹田市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府高槻市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府守口市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府枚方市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府茨木市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府八尾市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府寝屋川市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大東市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府箕面市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府門真市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府摂津市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府四條畷市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府交野市", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府三島郡島本町", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府豊能郡豊能町", "scale": 40, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府豊能郡能勢町", "scale": 40, "isArea": true },
                    { "pref": "兵庫県", "addr": "兵庫県南あわじ市", "scale": 40, "isArea": true },
                    { "pref": "兵庫県", "addr": "兵庫県淡路市", "scale": 40, "isArea": true },
                    { "pref": "奈良県", "addr": "奈良県宇陀市", "scale": 40, "isArea": true },
                    { "pref": "奈良県", "addr": "奈良県生駒郡安堵町", "scale": 40, "isArea": true },
                    // 震度3
                    { "pref": "北海道", "addr": "北海道札幌市中央区", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道札幌市南区", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道札幌市西区", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道札幌市厚別区", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道札幌市清田区", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道石狩市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道石狩郡当別町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道小樽市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道虻田郡蘭越町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道余市郡余市町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道余市郡赤井川村", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道岩内郡共和町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道岩内郡岩内町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道古宇郡泊村", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道古宇郡神恵内村", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道積丹郡積丹町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道古平郡古平町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道余市郡仁木町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道松前郡福島町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道檜山郡上ノ国町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道檜山郡江差町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道奥尻郡奥尻町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道島牧郡島牧村", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道寿都郡黒松内町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道山越郡長万部町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道芦別市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道赤平市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道滝川市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道砂川市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道歌志内市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道深川市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道空知郡奈井江町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道空知郡上砂川町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道樺戸郡新十津川町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道雨竜郡妹背牛町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道雨竜郡秩父別町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道雨竜郡雨竜町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道雨竜郡北竜町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道雨竜郡沼田町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道旭川市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡鷹栖町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡東神楽町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡当麻町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡比布町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡愛別町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡上川町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡東川町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡美瑛町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道空知郡上富良野町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道空知郡中富良野町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道空知郡南富良野町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道勇払郡占冠村", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡和寒町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道上川郡剣淵町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道雨竜郡幌加内町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道増毛郡増毛町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道留萌郡小平町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道苫前郡苫前町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道苫前郡羽幌町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道苫前郡初山別村", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道天塩郡遠別町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道天塩郡天塩町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道天塩郡豊富町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道天塩郡幌延町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道室蘭市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道伊達市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道有珠郡壮瞥町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道北見市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道網走市", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道網走郡美幌町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道網走郡津別町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道斜里郡斜里町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道斜里郡清里町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道斜里郡小清水町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道常呂郡訓子府町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道常呂郡置戸町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道常呂郡佐呂間町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道紋別郡遠軽町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道紋別郡湧別町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道紋別郡滝上町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道紋別郡興部町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道紋別郡西興部村", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道紋別郡雄武町", "scale": 30, "isArea": true },
                    { "pref": "北海道", "addr": "北海道網走郡大空町", "scale": 30, "isArea": true },
                    { "pref": "青森県", "addr": "青森県中津軽郡西目屋村", "scale": 30, "isArea": true },
                    { "pref": "青森県", "addr": "青森県西津軽郡鰺ヶ沢町", "scale": 30, "isArea": true },
                    { "pref": "青森県", "addr": "青森県西津軽郡深浦町", "scale": 30, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県上閉伊郡大槌町", "scale": 30, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県山本郡藤里町", "scale": 30, "isArea": true },
                    { "pref": "山形県", "addr": "山形県西置賜郡小国町", "scale": 30, "isArea": true },
                    { "pref": "福島県", "addr": "福島県河沼郡柳津町", "scale": 30, "isArea": true },
                    { "pref": "福島県", "addr": "福島県大沼郡三島町", "scale": 30, "isArea": true },
                    { "pref": "福島県", "addr": "福島県大沼郡金山町", "scale": 30, "isArea": true },
                    { "pref": "福島県", "addr": "福島県大沼郡昭和村", "scale": 30, "isArea": true },
                    { "pref": "福島県", "addr": "福島県南会津郡南会津町", "scale": 30, "isArea": true },
                    { "pref": "福島県", "addr": "福島県南会津郡下郷町", "scale": 30, "isArea": true },
                    { "pref": "福島県", "addr": "福島県南会津郡檜枝岐村", "scale": 30, "isArea": true },
                    { "pref": "福島県", "addr": "福島県南会津郡只見町", "scale": 30, "isArea": true },
                    { "pref": "福島県", "addr": "福島県耶麻郡北塩原村", "scale": 30, "isArea": true },
                    { "pref": "東京都", "addr": "東京都神津島村", "scale": 30, "isArea": true },
                    { "pref": "東京都", "addr": "東京都青ヶ島村", "scale": 30, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県上越市", "scale": 30, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県糸魚川市", "scale": 30, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県妙高市", "scale": 30, "isArea": true },
                    { "pref": "新潟県", "addr": "新潟県南魚沼郡湯沢町", "scale": 30, "isArea": true },
                    { "pref": "富山県", "addr": "富山県黒部市", "scale": 30, "isArea": true },
                    { "pref": "富山県", "addr": "富山県下新川郡入善町", "scale": 30, "isArea": true },
                    { "pref": "石川県", "addr": "石川県野々市市", "scale": 30, "isArea": true },
                    { "pref": "福井県", "addr": "福井県小浜市", "scale": 30, "isArea": true },
                    { "pref": "福井県", "addr": "福井県大野市", "scale": 30, "isArea": true },
                    { "pref": "福井県", "addr": "福井県勝山市", "scale": 30, "isArea": true },
                    { "pref": "福井県", "addr": "福井県鯖江市", "scale": 30, "isArea": true },
                    { "pref": "福井県", "addr": "福井県今立郡池田町", "scale": 30, "isArea": true },
                    { "pref": "福井県", "addr": "福井県南条郡南越前町", "scale": 30, "isArea": true },
                    { "pref": "福井県", "addr": "福井県三方郡美浜町", "scale": 30, "isArea": true },
                    { "pref": "福井県", "addr": "福井県大飯郡高浜町", "scale": 30, "isArea": true },
                    { "pref": "福井県", "addr": "福井県大飯郡おおい町", "scale": 30, "isArea": true },
                    { "pref": "福井県", "addr": "福井県三方上中郡若狭町", "scale": 30, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県韮崎市", "scale": 30, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県北杜市", "scale": 30, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県甲斐市", "scale": 30, "isArea": true },
                    { "pref": "山梨県", "addr": "山梨県南巨摩郡早川町", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県松本市", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県須坂市", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県伊那市", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県駒ヶ根市", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県塩尻市", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県安曇野市", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上伊那郡辰野町", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上伊那郡箕輪町", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上伊那郡飯島町", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上伊那郡南箕輪村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上伊那郡中川村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上伊那郡宮田村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県下伊那郡松川町", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県下伊那郡高森町", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県下伊那郡阿南町", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県下伊那郡阿智村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県下伊那郡喬木村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県下伊那郡豊丘村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県木曽郡木曽町", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県東筑摩郡麻績村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県東筑摩郡生坂村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県東筑摩郡筑北村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県上高井郡高山村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県木曽郡木祖村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県木曽郡王滝村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県木曽郡大桑村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県飯山市", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県北安曇郡白馬村", "scale": 30, "isArea": true },
                    { "pref": "長野県", "addr": "長野県北安曇郡小谷村", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県岐阜市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県大垣市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県多治見市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県関市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県瑞浪市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県羽島市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県美濃加茂市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県土岐市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県各務原市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県可児市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県山県市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県瑞穂市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県郡上市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県下呂市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県海津市", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県羽島郡岐南町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県羽島郡笠松町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県養老郡養老町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県不破郡垂井町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県不破郡関ケ原町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県安八郡神戸町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県安八郡輪之内町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県安八郡安八町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県揖斐郡揖斐川町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県揖斐郡大野町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県揖斐郡池田町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県本巣郡北方町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県加茂郡坂祝町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県加茂郡富加町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県加茂郡川辺町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県加茂郡七宗町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県加茂郡八百津町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県加茂郡白川町", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県加茂郡東白川村", "scale": 30, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県可児郡御嵩町", "scale": 30, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡市島田市", "scale": 30, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡市磐田市", "scale": 30, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡市焼津市", "scale": 30, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡市藤枝市", "scale": 30, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡市榛原郡吉田町", "scale": 30, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡市榛原郡川根本町", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋千種区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋東区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋北区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋西区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋中村区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋中区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋昭和区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋瑞穂区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋熱田区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋中川区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋守山区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋緑区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋名東区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "名古屋天白区", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "一宮市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "瀬戸市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "半田市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "春日井市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "津島市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "碧南市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "犬山市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "江南市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "小牧市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "岩倉市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "豊明市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "日進市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "清須市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "北名古屋市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "長久手市", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "西春日井郡豊山町", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "丹羽郡大口町", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "丹羽郡扶桑町", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "海部郡七宝町", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "海部郡甚目寺町", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "海部郡大治町", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "海部郡蟹江町", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "海部郡飛島村", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "幡豆郡一色町", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "幡豆郡吉良町", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "幡豆郡幡豆町", "scale": 30, "isArea": true },
                    { "pref": "愛知県", "addr": "北設楽郡東栄町", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "津市", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "伊勢市", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "松阪市", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "名張市", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "尾鷲市", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "鳥羽市", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "熊野市", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "志摩市", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "伊賀市", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "多気郡多気町", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "多気郡明和町", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "多気郡大台町", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "度会郡玉城町", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "度会郡度会町", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "度会郡大紀町", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "度会郡南伊勢町", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "北牟婁郡紀北町", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "南牟婁郡御浜町", "scale": 30, "isArea": true },
                    { "pref": "三重県", "addr": "南牟婁郡紀宝町", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "京都市北区", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "京都市上京区", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "京都市左京区", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "京都市東山区", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "京都市下京区", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "京都市南区", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "京都市山科区", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "福知山市", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "舞鶴市", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "綾部市", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "宮津市", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "京丹後市", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "与謝郡伊根町", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "与謝郡与謝野町", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "綴喜郡宇治田原町", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "相楽郡笠置町", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "相楽郡和束町", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "相楽郡南山城村", "scale": 30, "isArea": true },
                    { "pref": "京都府", "addr": "船井郡京丹波町", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市福島区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市此花区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市西区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市天王寺区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市浪速区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市東成区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市生野区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市阿倍野区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市住吉区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市東住吉区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市西成区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪市中央区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "堺市堺区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "堺市中区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "堺市東区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "堺市西区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "堺市南区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "堺市北区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "堺市美原区", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "岸和田市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "泉大津市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "貝塚市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "泉佐野市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "富田林市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "河内長野市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "松原市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "和泉市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "柏原市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "羽曳野市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "高石市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "藤井寺市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "東大阪市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "泉南市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "阪南市", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "泉北郡忠岡町", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "泉南郡熊取町", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "泉南郡田尻町", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "泉南郡岬町", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "南河内郡太子町", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "南河内郡河南町", "scale": 30, "isArea": true },
                    { "pref": "大阪府", "addr": "南河内郡千早赤阪村", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "兵庫県豊岡市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神戸市東灘区", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神戸市灘区", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神戸市兵庫区", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神戸市長田区", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神戸市須磨区", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神戸市垂水区", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神戸市北区", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神戸市中央区", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神戸市西区", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "姫路市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "尼崎市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "明石市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "西宮市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "洲本市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "芦屋市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "伊丹市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "相生市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "加古川市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "赤穂市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "西脇市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "宝塚市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "三木市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "高砂市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "川西市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "小野市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "三田市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "加西市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "丹波篠山市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "養父市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "丹波市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "朝来市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "宍粟市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "加東市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "たつの市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "川辺郡猪名川町", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "多可郡多可町", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "加古郡稲美町", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "加古郡播磨町", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神崎郡市川町", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神崎郡福崎町", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "神崎郡神河町", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "揖保郡太子町", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "赤穂郡上郡町", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "佐用郡佐用町", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "美方郡香美町", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "美方郡新温泉町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "奈良県大和郡山市", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "奈良市", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "大和高田市", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "天理市", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "橿原市", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "桜井市", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "五條市", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "御所市", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "生駒市", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "香芝市", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "葛城市", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "生駒郡平群町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "生駒郡三郷町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "生駒郡斑鳩町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "磯城郡川西町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "磯城郡三宅町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "磯城郡田原本町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "宇陀郡曽爾村", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "高市郡明日香村", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "北葛城郡上牧町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "北葛城郡王寺町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "北葛城郡広陵町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "北葛城郡河合町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "吉野郡吉野町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "吉野郡大淀町", "scale": 30, "isArea": true },
                    { "pref": "奈良県", "addr": "吉野郡下市町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "和歌山県新宮市", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "和歌山市", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "海南市", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "橋本市", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "有田市", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "御坊市", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "田辺市", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "岩出市", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "紀の川市", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "海草郡紀美野町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "伊都郡かつらぎ町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "伊都郡九度山町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "伊都郡高野町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "有田郡湯浅町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "有田郡広川町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "有田郡有田川町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "日高郡美浜町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "日高郡日高町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "日高郡由良町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "日高郡印南町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "日高郡みなべ町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "日高郡日高川町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "西牟婁郡白浜町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "西牟婁郡上富田町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "西牟婁郡すさみ町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "東牟婁郡那智勝浦町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "東牟婁郡太地町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "東牟婁郡古座川町", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "東牟婁郡北山村", "scale": 30, "isArea": true },
                    { "pref": "和歌山県", "addr": "東牟婁郡串本町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "鳥取県境港市", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "鳥取市", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "米子市", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "倉吉市", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "岩美郡岩美町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "八頭郡智頭町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "東伯郡三朝町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "東伯郡湯梨浜町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "東伯郡琴浦町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "東伯郡北栄町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "西伯郡日吉津村", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "西伯郡大山町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "西伯郡南部町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "西伯郡伯耆町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "日野郡日南町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "日野郡日野町", "scale": 30, "isArea": true },
                    { "pref": "鳥取県", "addr": "日野郡江府町", "scale": 30, "isArea": true },
                    { "pref": "島根県", "addr": "島根県隠岐郡隠岐の島町", "scale": 30, "isArea": true },
                    { "pref": "島根県", "addr": "松江市", "scale": 30, "isArea": true },
                    { "pref": "島根県", "addr": "出雲市", "scale": 30, "isArea": true },
                    { "pref": "島根県", "addr": "安来市", "scale": 30, "isArea": true },
                    { "pref": "島根県", "addr": "雲南市", "scale": 30, "isArea": true },
                    { "pref": "島根県", "addr": "仁多郡奥出雲町", "scale": 30, "isArea": true },
                    { "pref": "島根県", "addr": "隠岐郡西ノ島町", "scale": 30, "isArea": true },
                    { "pref": "島根県", "addr": "隠岐郡海士町", "scale": 30, "isArea": true },
                    { "pref": "島根県", "addr": "隠岐郡知夫村", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "岡山県岡山市北区", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "岡山市東区", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "岡山市中区", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "岡山市南区", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "倉敷市", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "玉野市", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "笠岡市", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "井原市", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "総社市", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "高梁市", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "備前市", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "瀬戸内市", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "赤磐市", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "真庭市", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "浅口市", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "和気郡和気町", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "都窪郡早島町", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "浅口郡里庄町", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "小田郡矢掛町", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "苫田郡鏡野町", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "岡山県久米郡美咲町", "scale": 30, "isArea": true },
                    { "pref": "岡山県", "addr": "加賀郡吉備中央町", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "広島県呉市", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "広島市中区", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "福山市", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "府中市", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "大竹市", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "東広島市", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "廿日市市", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "安芸高田市", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "江田島市", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "安芸郡府中町", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "安芸郡海田町", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "安芸郡坂町", "scale": 30, "isArea": true },
                    { "pref": "広島県", "addr": "豊田郡大崎上島町", "scale": 30, "isArea": true },
                    { "pref": "山口県", "addr": "柳井市", "scale": 30, "isArea": true },
                    { "pref": "山口県", "addr": "大島郡周防大島町", "scale": 30, "isArea": true },
                    { "pref": "山口県", "addr": "熊毛郡上関町", "scale": 30, "isArea": true },
                    { "pref": "山口県", "addr": "熊毛郡平生町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "徳島県徳島市", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "鳴門市", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "小松島市", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "阿南市", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "吉野川市", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "阿波市", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "美馬市", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "三好市", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "勝浦郡勝浦町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "勝浦郡上勝町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "名東郡佐那河内村", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "名西郡石井町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "名西郡神山町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "那賀郡那賀町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "海部郡牟岐町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "海部郡美波町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "海部郡海陽町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "板野郡松茂町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "板野郡北島町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "板野郡藍住町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "板野郡板野町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "板野郡上板町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "美馬郡つるぎ町", "scale": 30, "isArea": true },
                    { "pref": "徳島県", "addr": "三好郡東みよし町", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "香川県高松市", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "丸亀市", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "坂出市", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "善通寺市", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "観音寺市", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "さぬき市", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "東かがわ市", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "三豊市", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "小豆郡土庄町", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "小豆郡小豆島町", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "木田郡三木町", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "香川郡直島町", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "綾歌郡宇多津町", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "綾歌郡綾川町", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "仲多度郡琴平町", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "仲多度郡多度津町", "scale": 30, "isArea": true },
                    { "pref": "香川県", "addr": "仲多度郡まんのう町", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "愛媛県今治市", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "松山市", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "宇和島市", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "八幡浜市", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "新居浜市", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "西条市", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "大洲市", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "伊予市", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "四国中央市", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "西予市", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "東温市", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "越智郡上島町", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "上浮穴郡久万高原町", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "伊予郡砥部町", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "喜多郡内子町", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "西宇和郡伊方町", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "北宇和郡松野町", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "北宇和郡鬼北町", "scale": 30, "isArea": true },
                    { "pref": "愛媛県", "addr": "南宇和郡愛南町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "高知県安芸市", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "高知市", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "室戸市", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "南国市", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "土佐市", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "須崎市", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "宿毛市", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "土佐清水市", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "四万十市", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "香南市", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "香美市", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "安芸郡東洋町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "安芸郡奈半利町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "安芸郡田野町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "安芸郡安田町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "安芸郡北川村", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "安芸郡馬路村", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "安芸郡芸西村", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "長岡郡本山町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "長岡郡大豊町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "土佐郡土佐町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "土佐郡大川村", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "吾川郡いの町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "吾川郡仁淀川町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "高岡郡中土佐町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "高岡郡佐川町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "高岡郡越知町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "高岡郡梼原町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "高岡郡日高村", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "高岡郡津野町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "高岡郡四万十町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "幡多郡大月町", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "幡多郡三原村", "scale": 30, "isArea": true },
                    { "pref": "高知県", "addr": "幡多郡黒潮町", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "福岡県北九州市小倉北区", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "北九州市小倉南区", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "北九州市若松区", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "北九州市戸畑区", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "北九州市八幡東区", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "北九州市八幡西区", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "福岡市東区", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "福岡市博多区", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "福岡市中央区", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "飯塚市", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "行橋市", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "中間市", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "宗像市", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "古賀市", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "福津市", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "宮若市", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "嘉麻市", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "遠賀郡岡垣町", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "遠賀郡遠賀町", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "鞍手郡鞍手町", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "嘉穂郡桂川町", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "朝倉郡筑前町", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "田川郡福智町", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "京都郡みやこ町", "scale": 30, "isArea": true },
                    { "pref": "福岡県", "addr": "築上郡上毛町", "scale": 30, "isArea": true },
                    { "pref": "佐賀県", "addr": "佐賀県神埼市", "scale": 30, "isArea": true },
                    { "pref": "佐賀県", "addr": "佐賀市", "scale": 30, "isArea": true },
                    { "pref": "佐賀県", "addr": "鳥栖市", "scale": 30, "isArea": true },
                    { "pref": "佐賀県", "addr": "小城市", "scale": 30, "isArea": true },
                    { "pref": "佐賀県", "addr": "神埼郡吉野ヶ里町", "scale": 30, "isArea": true },
                    { "pref": "佐賀県", "addr": "三養基郡基山町", "scale": 30, "isArea": true },
                    { "pref": "佐賀県", "addr": "三養基郡上峰町", "scale": 30, "isArea": true },
                    { "pref": "佐賀県", "addr": "三養基郡みやき町", "scale": 30, "isArea": true },
                    { "pref": "佐賀県", "addr": "杵島郡白石町", "scale": 30, "isArea": true },
                    { "pref": "長崎県", "addr": "長崎県南島原市", "scale": 30, "isArea": true },
                    { "pref": "長崎県", "addr": "諫早市", "scale": 30, "isArea": true },
                    { "pref": "長崎県", "addr": "雲仙市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "熊本県阿蘇市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "熊本市中央区", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "熊本市東区", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "熊本市西区", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "熊本市南区", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "熊本市北区", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "八代市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "人吉市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "荒尾市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "玉名市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "山鹿市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "菊池市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "宇土市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "上天草市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "宇城市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "合志市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "下益城郡美里町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "玉名郡玉東町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "玉名郡南関町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "玉名郡長洲町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "玉名郡和水町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "菊池郡大津町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "菊池郡菊陽町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "阿蘇郡高森町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "阿蘇郡西原村", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "阿蘇郡南阿蘇村", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "上益城郡御船町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "上益城郡嘉島町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "上益城郡益城町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "上益城郡甲佐町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "上益城郡山都町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "八代郡氷川町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "葦北郡芦北町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "球磨郡錦町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "球磨郡多良木町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "球磨郡湯前町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "球磨郡水上村", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "球磨郡相良村", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "球磨郡五木村", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "球磨郡山江村", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "球磨郡球磨村", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "球磨郡あさぎり町", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "天草市", "scale": 30, "isArea": true },
                    { "pref": "熊本県", "addr": "天草郡苓北町", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "大分県佐伯市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "大分市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "別府市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "中津市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "日田市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "臼杵市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "津久見市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "竹田市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "豊後高田市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "杵築市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "宇佐市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "豊後大野市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "由布市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "国東市", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "東国東郡姫島村", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "速見郡日出町", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "玖珠郡九重町", "scale": 30, "isArea": true },
                    { "pref": "大分県", "addr": "玖珠郡玖珠町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "宮崎県延岡市", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "宮崎市", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "日南市", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "小林市", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "日向市", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "西都市", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "えびの市", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "西諸県郡高原町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "東諸県郡国富町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "東諸県郡綾町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "児湯郡高鍋町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "児湯郡新富町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "児湯郡西米良村", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "児湯郡木城町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "児湯郡川南町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "児湯郡都農町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "東臼杵郡門川町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "東臼杵郡諸塚村", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "東臼杵郡椎葉村", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "東臼杵郡美郷町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "西臼杵郡高千穂町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "西臼杵郡日之影町", "scale": 30, "isArea": true },
                    { "pref": "宮崎県", "addr": "西臼杵郡五ヶ瀬町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "鹿児島県薩摩川内市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "鹿児島市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "鹿屋市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "枕崎市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "阿久根市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "出水市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "指宿市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "垂水市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "日置市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "曽於市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "霧島市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "いちき串木野市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "南さつま市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "志布志市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "南九州市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "伊佐市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "姶良市", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "鹿児島郡三島村", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "薩摩郡さつま町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "出水郡長島町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "姶良郡湧水町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "曽於郡大崎町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "肝属郡東串良町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "肝属郡錦江町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "肝属郡南大隅町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "肝属郡肝付町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "熊毛郡中種子町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "熊毛郡南種子町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "熊毛郡屋久島町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "大島郡大和村", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "大島郡宇検村", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "大島郡瀬戸内町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "大島郡龍郷町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "大島郡喜界町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "大島郡徳之島町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "大島郡天城町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "大島郡伊仙町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "大島郡和泊町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "大島郡知名町", "scale": 30, "isArea": true },
                    { "pref": "鹿児島県", "addr": "大島郡与論町", "scale": 30, "isArea": true }
                ]
            },
            // --- 【新規追加】訓練用の東日本大震災津波情報 (code: 552) ---
            {
                "code": 552,
                "issue": {
                    "source": "気象庁",
                    "time": "2011/03/11 14:49:00",
                    "type": "ScaleAndDestination",
                    "correct": "None",
                    "event_id": "20110311144600"
                },
                "tsunami": {
                    "forecasts": [
                        { "grade": "MajorWarning", "area": { "name": "岩手県" } },
                        { "grade": "MajorWarning", "area": { "name": "宮城県" } },
                        { "grade": "MajorWarning", "area": { "name": "福島県" } },
                        { "grade": "Warning", "area": { "name": "青森県太平洋沿岸" } },
                        { "grade": "Warning", "area": { "name": "茨城県" } },
                        { "grade": "Warning", "area": { "name": "千葉県九十九里・外房" } },
                        { "grade": "Warning", "area": { "name": "伊豆諸島" } },
                        { "grade": "Advisory", "area": { "name": "北海道太平洋沿岸東部" } },
                        { "grade": "Advisory", "area": { "name": "北海道太平洋沿岸中部" } },
                        { "grade": "Advisory", "area": { "name": "北海道太平洋沿岸西部" } },
                        { "grade": "Advisory", "area": { "name": "青森県日本海沿岸" } },
                        { "grade": "Advisory", "area": { "name": "陸奥湾" } },
                        { "grade": "Advisory", "area": { "name": "千葉県内房" } },
                        { "grade": "Advisory", "area": { "name": "相模湾・三浦半島" } },
                        { "grade": "Advisory", "area": { "name": "静岡県" } },
                        { "grade": "Advisory", "area": { "name": "愛知県外海" } },
                        { "grade": "Advisory", "area": { "name": "三重県南部" } },
                        { "grade": "Advisory", "area": { "name": "和歌山県" } },
                        { "grade": "Advisory", "area": { "name": "徳島県" } },
                        { "grade": "Advisory", "area": { "name": "高知県" } },
                        { "grade": "Advisory", "area": { "name": "宮崎県" } }
                    ]
                }
            },
            // --- 訓練用の大正関東大震災津波情報 (code: 552) ---
            {
                "code": 552,
                "issue": {
                    "source": "気象庁",
                    "time": "1923/09/01 12:01:00",
                    "type": "ScaleAndDestination",
                    "correct": "None",
                    "event_id": "19230901115800" // 地震情報と紐付けるID
                },
                "tsunami": {
                    "forecasts": [
                        { "grade": "Warning", "area": { "name": "相模湾・三浦半島" } },
                        { "grade": "Warning", "area": { "name": "静岡県" } },
                        { "grade": "Advisory", "area": { "name": "千葉県九十九里・外房" } },
                        { "grade": "Advisory", "area": { "name": "伊豆諸島" } }
                    ]
                }
            },
            // --- 【新規追加】訓練用の東日本大震災津波観測情報 (code: 556) ---
            {
                "code": 556,
                "cancelled": false,
                "issue": {
                    "source": "気象庁",
                    "time": "2011/03/11 15:30:00",
                    "type": "Tsunami",
                    "event_id": "20110311144600"
                },
                "areas": [
                    {
                        "grade": "MajorWarning",
                        "immediate": true,
                        "name": "宮城県",
                        "stations": [
                            { "name": "石巻市鮎川", "time": "2011-03-11T15:26:00+09:00", "height": 8.6, "condition": "観測中" },
                            { "name": "相馬", "time": "2011-03-11T15:20:00+09:00", "height": 9.3, "condition": "観測中" },
                            { "name": "大船渡", "time": "2011-03-11T15:18:00+09:00", "height": 8.0, "condition": "観測中" },
                            { "name": "釜石", "time": "2011-03-11T15:21:00+09:00", "height": 4.2, "condition": "観測中" }
                        ]
                    }
                ]
            },

            // --- 訓練用の十勝沖地震データ (code: 551) ---
            {
                "code": 551,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/03/20 10:02:00",
                    "type": "DetailScale",
                    "correct": "None",
                    "event_id": "20250320100000" // 津波情報と紐付けるID
                },
                "earthquake": {
                    "time": "2025-03-20T10:00:00+09:00",
                    "hypocenter": {
                        "name": "十勝沖",
                        "latitude": 42.5,
                        "longitude": 144.1,
                        "depth": 40,
                        "magnitude": 8.0
                    },
                    "maxScale": 60, // 震度6強
                    "domesticTsunami": "Warning" // 津波警報
                },
                "points": [
                    { "pref": "北海道", "addr": "北海道浦幌町", "scale": 60, "isArea": true },
                    { "pref": "北海道", "addr": "北海道釧路市", "scale": 55, "isArea": true },
                    { "pref": "北海道", "addr": "北海道帯広市", "scale": 55, "isArea": true },
                    { "pref": "青森県", "addr": "青森県八戸市", "scale": 50, "isArea": true },
                    { "pref": "岩手県", "addr": "岩手県盛岡市", "scale": 50, "isArea": true },
                    { "pref": "北海道", "addr": "北海道札幌市中央区", "scale": 45, "isArea": true },
                    { "pref": "宮城県", "addr": "宮城県仙台市青葉区", "scale": 40, "isArea": true },
                    { "pref": "秋田県", "addr": "秋田県秋田市", "scale": 30, "isArea": true }
                ]
            },
            // --- 訓練用の十勝沖地震津波情報 (code: 552) ---
            {
                "code": 552,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/03/20 10:05:00",
                    "type": "ScaleAndDestination",
                    "correct": "None",
                    "event_id": "20250320100000" // 地震情報と紐付けるID
                },
                "tsunami": {
                    "forecasts": [
                        { "grade": "Warning", "area": { "name": "北海道太平洋沿岸東部" } },
                        { "grade": "Warning", "area": { "name": "北海道太平洋沿岸中部" } },
                        { "grade": "Advisory", "area": { "name": "北海道太平洋沿岸西部" } },
                        { "grade": "Advisory", "area": { "name": "青森県太平洋沿岸" } },
                        { "grade": "Advisory", "area": { "name": "岩手県" } },
                        { "grade": "Advisory", "area": { "name": "宮城県" } }
                    ]
                }
            },
                                  // --- 訓練用の南海トラフ地震データ (code: 551) ---
            {
                "code": 551,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/01/02 09:02:00",
                    "type": "DetailScale",
                    "correct": "None",
                    "event_id": "20250102090000" // 津波情報と紐付けるID
                },
                "earthquake": {
                    "time": "2025-01-02T09:00:00+09:00",
                    "hypocenter": {
                        "name": "南海トラフ",
                        "latitude": 33.0,
                        "longitude": 135.0,
                        "depth": 30,
                        "magnitude": 9.1
                    },
                    "maxScale": 70, // 震度7
                    "domesticTsunami": "MajorWarning" // 大津波警報
                },
                "points": [
                    { "pref": "高知県", "addr": "高知県高知市", "scale": 70, "isArea": true },
                    { "pref": "徳島県", "addr": "徳島県徳島市", "scale": 70, "isArea": true },
                    { "pref": "和歌山県", "addr": "和歌山県和歌山市", "scale": 70, "isArea": true },
                    { "pref": "静岡県", "addr": "静岡県静岡市", "scale": 60, "isArea": true },
                    { "pref": "愛知県", "addr": "愛知県名古屋市", "scale": 60, "isArea": true },
                    { "pref": "三重県", "addr": "三重県津市", "scale": 60, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市", "scale": 60, "isArea": true },
                    { "pref": "兵庫県", "addr": "兵庫県神戸市", "scale": 60, "isArea": true },
                    { "pref": "香川県", "addr": "香川県高松市", "scale": 60, "isArea": true },
                    { "pref": "愛媛県", "addr": "愛媛県松山市", "scale": 60, "isArea": true },
                    { "pref": "大分県", "addr": "大分県大分市", "scale": 60, "isArea": true },
                    { "pref": "宮崎県", "addr": "宮崎県宮崎市", "scale": 60, "isArea": true },
                    { "pref": "奈良県", "addr": "奈良県奈良市", "scale": 55, "isArea": true },
                    { "pref": "京都府", "addr": "京都府京都市", "scale": 55, "isArea": true },
                    { "pref": "岡山県", "addr": "岡山県岡山市", "scale": 55, "isArea": true },
                    { "pref": "広島県", "addr": "広島県広島市", "scale": 55, "isArea": true },
                    { "pref": "山口県", "addr": "山口県山口市", "scale": 55, "isArea": true },
                    { "pref": "福岡県", "addr": "福岡県福岡市", "scale": 55, "isArea": true },
                    { "pref": "佐賀県", "addr": "佐賀県佐賀市", "scale": 55, "isArea": true },
                    { "pref": "熊本県", "addr": "熊本県熊本市", "scale": 55, "isArea": true },
                    { "pref": "鹿児島県", "addr": "鹿児島県鹿児島市", "scale": 55, "isArea": true },
                    { "pref": "東京都", "addr": "東京都千代田区", "scale": 50, "isArea": true },
                    { "pref": "神奈川県", "addr": "神奈川県横浜市", "scale": 50, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県大津市", "scale": 50, "isArea": true },
                    { "pref": "鳥取県", "addr": "鳥取県鳥取市", "scale": 50, "isArea": true },
                    { "pref": "島根県", "addr": "島根県松江市", "scale": 50, "isArea": true },
                    { "pref": "長崎県", "addr": "長崎県長崎市", "scale": 50, "isArea": true },
                    { "pref": "沖縄県", "addr": "沖縄県那覇市", "scale": 40, "isArea": true }
                ]
            },
            // --- 訓練用の南海トラフ津波情報 (code: 552) ---
            {
                "code": 552,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/01/02 09:05:00",
                    "type": "ScaleAndDestination",
                    "correct": "None",
                    "event_id": "20250102090000" // 地震情報と紐付けるID
                },
                "tsunami": {
                    "forecasts": [
                        { "grade": "MajorWarning", "area": { "name": "静岡県" } },
                        { "grade": "MajorWarning", "area": { "name": "愛知県外海" } },
                        { "grade": "MajorWarning", "area": { "name": "三重県南部" } },
                        { "grade": "MajorWarning", "area": { "name": "和歌山県" } },
                        { "grade": "MajorWarning", "area": { "name": "徳島県" } },
                        { "grade": "MajorWarning", "area": { "name": "高知県" } },
                        { "grade": "MajorWarning", "area": { "name": "宮崎県" } },
                        { "grade": "Warning", "area": { "name": "千葉県九十九里・外房" } },
                        { "grade": "Warning", "area": { "name": "神奈川県" } },
                        { "grade": "Warning", "area": { "name": "大阪府" } },
                        { "grade": "Warning", "area": { "name": "兵庫県瀬戸内海沿岸" } },
                        { "grade": "Warning", "area": { "name": "岡山県" } },
                        { "grade": "Warning", "area": { "name": "広島県" } },
                        { "grade": "Warning", "area": { "name": "山口県瀬戸内海沿岸" } },
                        { "grade": "Warning", "area": { "name": "大分県" } },
                        { "grade": "Warning", "area": { "name": "鹿児島県東部" } },
                        { "grade": "Advisory", "area": { "name": "東京都伊豆諸島" } },
                        { "grade": "Advisory", "area": { "name": "東京都小笠原諸島" } },
                        { "grade": "Advisory", "area": { "name": "愛知県内海" } },
                        { "grade": "Advisory", "area": { "name": "瀬戸内海沿岸" } },
                        { "grade": "Advisory", "area": { "name": "九州西岸" } },
                        { "grade": "Advisory", "area": { "name": "沖縄本島地方" } }
                    ]
                }
            },
            // --- 訓練用の香川県東部地震データ (code: 551) ---
            {
                "code": 551,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/11/07 15:05:00",
                    "type": "DetailScale",
                    "correct": "None",
                    "event_id": "20251107150000" // 津波情報と紐付けるID
                },
                "earthquake": {
                    "time": "2025-11-07T15:00:00+09:00",
                    "hypocenter": {
                        "name": "香川県東部",
                        "latitude": 34.3,
                        "longitude": 134.2,
                        "depth": 10,
                        "magnitude": 7.0
                    },
                    "maxScale": 60, // 震度6強
                    "domesticTsunami": "None" // 津波なし
                },
                "points": [
                    { "pref": "香川県", "addr": "香川県高松市", "scale": 60, "isArea": true },
                    { "pref": "香川県", "addr": "香川県さぬき市", "scale": 55, "isArea": true },
                    { "pref": "香川県", "addr": "香川県丸亀市", "scale": 50, "isArea": true },
                    { "pref": "徳島県", "addr": "徳島県徳島市", "scale": 45, "isArea": true },
                    { "pref": "岡山県", "addr": "岡山県岡山市", "scale": 40, "isArea": true },
                    { "pref": "愛媛県", "addr": "愛媛県松山市", "scale": 30, "isArea": true }
                ]
            },
            // --- 訓練用の大阪府北部（上町断層帯）地震データ (code: 551) ---
            {
                "code": 551,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/01/03 14:32:00",
                    "type": "DetailScale",
                    "correct": "None",
                    "event_id": "20250103143000"
                },
                "earthquake": {
                    "time": "2025-01-03T14:30:00+09:00",
                    "hypocenter": {
                        "name": "大阪府北部",
                        "latitude": 34.7,
                        "longitude": 135.5,
                        "depth": 10,
                        "magnitude": 7.5
                    },
                    "maxScale": 70,
                    "domesticTsunami": "None"
                },
                "points": [
                    { "pref": "大阪府", "addr": "大阪府大阪市中央区", "scale": 70, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府大阪市北区", "scale": 70, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府堺市堺区", "scale": 60, "isArea": true },
                    { "pref": "大阪府", "addr": "大阪府豊中市", "scale": 60, "isArea": true },
                    { "pref": "兵庫県", "addr": "兵庫県尼崎市", "scale": 60, "isArea": true },
                    { "pref": "京都府", "addr": "京都府京都市伏見区", "scale": 55, "isArea": true },
                    { "pref": "奈良県", "addr": "奈良県奈良市", "scale": 55, "isArea": true },
                    { "pref": "和歌山県", "addr": "和歌山県和歌山市", "scale": 55, "isArea": true },
                    { "pref": "滋賀県", "addr": "滋賀県大津市", "scale": 55, "isArea": true },
                    { "pref": "兵庫県", "addr": "兵庫県神戸市東灘区", "scale": 50, "isArea": true },
                    { "pref": "三重県", "addr": "三重県津市", "scale": 50, "isArea": true },
                    { "pref": "岐阜県", "addr": "岐阜県岐阜市", "scale": 45, "isArea": true },
                    { "pref": "福井県", "addr": "福井県福井市", "scale": 45, "isArea": true },
                    { "pref": "徳島県", "addr": "徳島県徳島市", "scale": 40, "isArea": true }
                ]
            },
            // --- 訓練用の津波情報 (code: 552) ---
            {
                "code": 552,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/01/01 12:05:00",
                    "type": "ScaleAndDestination",
                    "correct": "None",
                    "event_id": "20250101120000" // 地震情報と紐付けるID
                },
                "tsunami": {
                    "forecasts": [
                        // 大津波警報
                        { "grade": "MajorWarning", "area": { "name": "石川県能登" } },
                        { "grade": "MajorWarning", "area": { "name": "新潟県上中下越" } },
                        // 津波警報
                        { "grade": "Warning", "area": { "name": "山形県" } },
                        { "grade": "Warning", "area": { "name": "兵庫県北部" } },
                        { "grade": "Warning", "area": { "name": "北海道日本海沿岸南部" } },
                        // 津波注意報
                        { "grade": "Advisory", "area": { "name": "京都府" } },
                        { "grade": "Advisory", "area": { "name": "福井県" } },
                        { "grade": "Advisory", "area": { "name": "鳥取県" } },
                        { "grade": "Advisory", "area": { "name": "島根県出雲・石見" } },
                        { "grade": "Advisory", "area": { "name": "福岡県日本海沿岸" } },
                        { "grade": "Advisory", "area": { "name": "佐賀県北部" } },
                        { "grade": "Advisory", "area": { "name": "長崎県壱岐・対馬" } },
                    ]
                }
            },
            // --- 訓練用の震源・震度情報 (code: 551) ---
            {
                "code": 551,
                "issue": {
                    "source": "気象庁",
                    "time": "2025/01/01 12:02:00",
                    "type": "DetailScale",
                    "correct": "None",
                    "event_id": "20250101120000" // 津波情報と紐付けるID
                },
                "earthquake": {
                    "time": "2025-01-01T12:00:00+09:00",
                    "hypocenter": {
                        "name": "日本海中部",
                        "latitude": 39.9,
                        "longitude": 138.6,
                        "depth": 10,
                        "magnitude": 8.1
                    },
                    "maxScale": 70, // 震度7
                    "domesticTsunami": "MajorWarning" // 大津波警報
                },
                "points": [
                    // 震度7
                    { "pref": "新潟県", "addr": "新潟県長岡市", "scale": 70, "isArea": true },
                    // 震度6強
                    { "pref": "石川県", "addr": "石川県輪島市", "scale": 60, "isArea": true },
                    { "pref": "山形県", "addr": "山形県鶴岡市", "scale": 60, "isArea": true },
                    // 震度6弱
                    { "pref": "新潟県", "addr": "新潟県柏崎市", "scale": 55, "isArea": true },
                    { "pref": "富山県", "addr": "富山県氷見市", "scale": 55, "isArea": true },
                    // 震度5強
                    { "pref": "石川県", "addr": "石川県珠洲市", "scale": 50, "isArea": true },
                    { "pref": "福井県", "addr": "福井県あわら市", "scale": 50, "isArea": true },
                    // 震度5弱
                    { "pref": "秋田県", "addr": "秋田県にかほ市", "scale": 45, "isArea": true },
                    { "pref": "長野県", "addr": "長野県栄村", "scale": 45, "isArea": true },
                    // 震度4
                    { "pref": "福島県", "addr": "福島県会津坂下町", "scale": 40, "isArea": true },
                    { "pref": "群馬県", "addr": "群馬県草津町", "scale": 40, "isArea": true },
                    // 震度3
                    { "pref": "京都府", "addr": "京都府京丹後市", "scale": 30, "isArea": true },
                    { "pref": "兵庫県", "addr": "兵庫県豊岡市", "scale": 30, "isArea": true },
                ]
            }
        ];
        const tsunamiDetailsMap = new Map();
        const tsunamiInfos = dummyData.filter(d => d.code === 552);
        tsunamiInfos.forEach(info => {
            const eventId = String(info.issue.event_id || info.issue.eventid);
            if (!info.tsunami || !info.tsunami.forecasts) return; // 修正: returnを追加
            const forecastsByGrade = { 'MajorWarning': new Set(), 'Warning': new Set(), 'Advisory': new Set() };
            info.tsunami.forecasts.forEach(forecast => { if (forecastsByGrade[forecast.grade] && forecast.area.name) { forecastsByGrade[forecast.grade].add(forecast.area.name); } });
            const grades = Object.keys(forecastsByGrade).filter(grade => forecastsByGrade[grade].size > 0);
            let highestGrade = 'None';
            if (grades.includes('MajorWarning')) highestGrade = 'MajorWarning'; else if (grades.includes('Warning')) highestGrade = 'Warning'; else if (grades.includes('Advisory')) highestGrade = 'Advisory';
            tsunamiDetailsMap.set(eventId, { highestGrade, areas: forecastsByGrade }); // 修正: 最後の閉じ括弧を修正
        });

        // ★★★ 修正: 訓練モードでも津波観測情報を処理する ★★★
        const tsunamiObservationMap = new Map();
        const observationInfos = dummyData.filter(d => d.code === 556 && !d.cancelled);
        observationInfos.forEach(info => {
            const eventId = String(info.issue.event_id || info.issue.eventid);
            if (!info.areas) return;
            let maxObservedHeight = 0;
            const stations = [];
            info.areas.forEach(area => {
                area.stations?.forEach(station => {
                    if (station.height > maxObservedHeight) maxObservedHeight = station.height;
                    stations.push(station);
                });
            });
            tsunamiObservationMap.set(eventId, { maxObservedHeight, stations });
        });

        // ★★★ 修正: 訓練モードでもEEWを処理する ★★★
        // 訓練データに含まれる全てのEEW(554)を候補として取得
        const eewCandidates = dummyData.filter(item => item.code === 554);
        if (eewCandidates.length > 0) {
            // 複数のEEW候補からランダムで1つを選択して表示
            const randomIndex = Math.floor(Math.random() * eewCandidates.length);
            const randomEew = eewCandidates[randomIndex];
            handleEew(randomEew);
        }

        const filteredEarthquakes = dummyData.filter(eq => eq.code === 551 && eq.earthquake && eq.earthquake.maxScale >= CONFIG.MIN_LIST_SCALE);

        PROCESSED_EARTHQUAKES = await Promise.all(filteredEarthquakes.map(eq => processEarthquake(eq, tsunamiDetailsMap, tsunamiObservationMap)));
        return PROCESSED_EARTHQUAKES;
    }

    const loadingElement = document.getElementById('loading');
    const errorElement = document.getElementById('error-message');
    const errorTextElement = document.getElementById('error-text');
    
    loadingElement.classList.remove('hidden');
    errorElement.classList.add('hidden');
    
    try {
        // 震度情報(551)、津波予報(552)、津波観測情報(556)を個別にリクエスト
        const urls = [
            `${CONFIG.API_URL}&codes=551`, // 震度情報
            `${CONFIG.API_URL}&codes=552`, // 津波予報
            `${CONFIG.API_URL}&codes=556`, // 津波観測情報
            `${CONFIG.API_URL}&codes=554`  // 緊急地震速報(予報)
        ];

        // Promise.allSettledを使い、一部のリクエスト失敗時も処理を継続
        const results = await Promise.allSettled(urls.map(url => fetch(url)));

        let data = [];
        for (const result of results) {
            if (result.status === 'fulfilled') {
                const response = result.value;
                if (response.ok) {
                    const json = await response.json();
                    // 取得したデータが配列であることを確認して結合
                    if (Array.isArray(json)) {
                        data = data.concat(json);
                    }
                } else {
                    // レスポンスがエラーでも処理は止めず、コンソールに警告を出す
                    console.warn(`APIからのデータ取得に一部失敗しました: ${response.status} ${response.statusText}`);
                }
            } else {
                // fetch自体が失敗した場合 (ネットワークエラーなど)
                console.error('APIへのリクエストに失敗しました:', result.reason);
            }
        }

        // --- 緊急地震速報(554)をチェック ---
        const eewInfo = data.find(item => item.code === 554);
        if (eewInfo) {
            handleEew(eewInfo);
        }

        // --- 1. 津波情報(552)を先に処理し、event_idごとに最高の警報レベルをマップに保存 ---
        const tsunamiDetailsMap = new Map();
        const tsunamiInfos = data.filter(d => d.code === 552);

        tsunamiInfos.forEach(info => {
            const eventId = String(info.issue.event_id || info.issue.eventid);
            if (!info.tsunami || !info.tsunami.forecasts) return;

            // 警報レベルごとの沿岸エリアを収集
            const forecastsByGrade = {
                'MajorWarning': new Set(),
                'Warning': new Set(),
                'Advisory': new Set()
            };
            info.tsunami.forecasts.forEach(forecast => {
                if (forecastsByGrade[forecast.grade] && forecast.area.name) {
                    forecastsByGrade[forecast.grade].add(forecast.area.name);
                }
            });

            const grades = Object.keys(forecastsByGrade).filter(grade => forecastsByGrade[grade].size > 0);
            let highestGrade = 'None';
            if (grades.includes('MajorWarning')) highestGrade = 'MajorWarning';
            else if (grades.includes('Warning')) highestGrade = 'Warning';
            else if (grades.includes('Advisory')) highestGrade = 'Advisory';

            tsunamiDetailsMap.set(eventId, { highestGrade, areas: forecastsByGrade });
        });

        // --- 2. 津波観測情報(556)を処理し、event_idごとに観測点をマップに保存 ---
        const tsunamiObservationMap = new Map();
        const observationInfos = data.filter(d => d.code === 556 && !d.cancelled);

        observationInfos.forEach(info => {
            const eventId = String(info.issue.event_id || info.issue.eventid);
            if (!info.areas) return;

            let maxObservedHeight = 0;
            const stations = [];

            info.areas.forEach(area => {
                area.stations?.forEach(station => {
                    if (station.height > maxObservedHeight) {
                        maxObservedHeight = station.height;
                    }
                    stations.push(station);
                });
            });

            tsunamiObservationMap.set(eventId, { maxObservedHeight, stations });
        });

        // 最大震度3以上の地震のみをフィルタリング (CONFIG.MIN_LIST_SCALEを使用)
        const filteredEarthquakes = data.filter(eq => 
            eq.code === 551 && eq.earthquake && typeof eq.earthquake.maxScale === 'number' && eq.earthquake.maxScale >= CONFIG.MIN_LIST_SCALE
        );

        // 「イベントキー」を元に重複排除・集約
        const uniqueEarthquakesMap = new Map();
        for (const eq of filteredEarthquakes) {
            // ★★★ 修正: hypocenterが存在しない場合も考慮 ★★★
            const eventTime = eq.earthquake?.time;
            const epicenterName = eq.earthquake?.hypocenter?.name;
 
            if (!eventTime || !epicenterName) continue; // ID生成に必要な情報がなければスキップ
 
            const eventKey = `${eventTime}_${epicenterName}`; // 発生時刻と震源地名から安定したイベントキーを生成

            if (uniqueEarthquakesMap.has(eventKey)) {
                // 既に同じ地震イベントが存在する場合、情報をマージする
                const existingEq = uniqueEarthquakesMap.get(eventKey);
                // ★★★ 観測点(points)データを持つ情報を優先するロジック ★★★
                if (!existingEq.points && eq.points) { // 既存にpointsがなく、新しい方にあれば
                    uniqueEarthquakesMap.set(eventKey, eq); // 新しい情報で上書きする
                }
                // ★★★ 修正: hypocenterが存在しない場合も考慮 ★★★
                if (eq.earthquake?.hypocenter && (existingEq.earthquake.hypocenter.magnitude === -1 || existingEq.earthquake.hypocenter.magnitude === null) && (eq.earthquake.hypocenter.magnitude !== -1 && eq.earthquake.hypocenter.magnitude !== null)) {
                    existingEq.earthquake.hypocenter = eq.earthquake.hypocenter;
                }
                // 最大震度が更新された場合
                if (eq.earthquake.maxScale > existingEq.earthquake.maxScale) {
                    existingEq.earthquake.maxScale = eq.earthquake.maxScale;
                }
                // 津波情報が更新された場合（例: "Checking" -> "None" や "Warning"）
                // domesticTsunamiはより危険度が高い情報で上書きする
                if (eq.earthquake.domesticTsunami !== existingEq.earthquake.domesticTsunami) {
                    existingEq.earthquake.domesticTsunami = eq.earthquake.domesticTsunami;
                }
            } else {
                // 新しい地震イベントとして追加
                uniqueEarthquakesMap.set(eventKey, eq);
            }
        }
        
        const uniqueEarthquakes = Array.from(uniqueEarthquakesMap.values());

        // 処理済みのデータセットをグローバル変数に格納
        // ★★★ 修正: 当日フィルタリングを削除し、取得した全てのユニークな地震を処理対象とする ★★★
        PROCESSED_EARTHQUAKES = await Promise.all(uniqueEarthquakes.map(eq => processEarthquake(eq, tsunamiDetailsMap, tsunamiObservationMap)));

        // 新しい地震データをスプレッドシートに記録
        if (PROCESSED_EARTHQUAKES.length > 0) {
            logToSpreadsheet(PROCESSED_EARTHQUAKES);
            logPointsToSpreadsheet(PROCESSED_EARTHQUAKES);
        }
        return PROCESSED_EARTHQUAKES;

    } catch (error) {
        console.error('地震情報の取得中にエラー:', error);
        errorTextElement.textContent = `データの取得に失敗しました: ${error.message}`;
        errorElement.classList.remove('hidden');
        return [];
    } finally {
        loadingElement.classList.add('hidden');
    }
};

/**
 * 地震データをGoogle Apps Scriptに送信してスプレッドシートに記録する
 * @param {Array} earthquakes - 処理済みの地震情報配列
 */
const logToSpreadsheet = async (earthquakes) => {
    const url = CONFIG.GAS_WEB_APP_URL;
    if (!url) {
        console.log('GAS_WEB_APP_URLが設定されていないため、スプレッドシートへの記録をスキップしました。');
        return;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            mode: 'no-cors', // CORSエラーを回避するために必要
            cache: 'no-cache',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(earthquakes)
        });
        console.log('スプレッドシートへの記録リクエストを送信しました。');
    } catch (error) {
        console.error('スプレッドシートへの記録中にエラーが発生しました:', error);
    }
};

/**
 * 観測点データをGoogle Apps Scriptに送信してスプレッドシートに記録する
 * @param {Array} earthquakes - 処理済みの地震情報配列
 */
const logPointsToSpreadsheet = (earthquakes) => {
    const url = CONFIG.GAS_POINTS_WEB_APP_URL;
    if (!url) { 
        console.log('GAS_POINTS_WEB_APP_URLが設定されていないため、観測点情報の記録をスキップしました。');
        return;
    } 

    // 地震ごとに観測点データを分割して送信する
    earthquakes.forEach(eq => {
        // 震度1以上の観測点のみを抽出
        const allPoints = eq.points?.filter(p => p.scale >= 10) || [];

        if (allPoints.length > 0) {
            // 震度階級の大きい順に並び替え、上位40件に制限
            const sortedAndLimitedPoints = allPoints
                .sort((a, b) => b.scale - a.scale)
                .slice(0, 40);

            // 各観測点データに、関連する地震IDを追加 
            const payload = sortedAndLimitedPoints.map(point => ({
                ...point,
                addr: `${point.pref}_${point.addr}`, // ★都道府県名と観測点名を連結
                earthquakeId: eq.id
            }));

            // 非同期で送信処理を実行（awaitしないことで、次の地震の処理をブロックしない）
            fetch(url, {
                method: 'POST',
                mode: 'no-cors', // CORSエラーを回避
                cache: 'no-cache',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            .then(() => {
                console.log(`地震ID: ${eq.id} の観測点データ(${payload.length}件)の記録リクエストを送信しました。`);
            })
            .catch(error => {
                console.error(`地震ID: ${eq.id} の観測点データ記録中にエラーが発生しました:`, error);
            });
        }
    });
};

/**
 * 個別の地震情報オブジェクトを処理し、描画に必要な基本情報と生のpointsデータを格納する
 * @param {Object} earthquake - APIから取得した単一の地震情報オブジェクト
 * @returns {Object} 処理後の整形済み地震情報
 */
const processEarthquake = async (earthquake, tsunamiDetailsMap, tsunamiObservationMap) => {
    // --- 安定したID生成ロジック ---
    const eqData = earthquake.earthquake;
    // ★★★ 修正: hypocenterが存在しないケースに対応 ★★★
    const epicenterName = eqData.hypocenter?.name || '不明';
    const idSource = `${eqData.time}_${epicenterName}`;
    const syntheticId = await digestMessage(idSource);

    // -------------------------

    // API提供のeventidは津波情報の紐付けにのみ利用
    const eventId = String(earthquake.issue?.event_id || earthquake.issue?.eventid);
    const tsunamiData = tsunamiDetailsMap.get(eventId);
    const tsunamiObservationData = tsunamiObservationMap.get(eventId);
    const detailedTsunamiGrade = tsunamiData ? tsunamiData.highestGrade : earthquake.earthquake.domesticTsunami;
    
    // ★★★ 修正: tsunamiDataが存在しない場合も考慮 ★★★
    const tsunamiBadges = [];
    if (tsunamiData) {
        if (tsunamiData.areas.MajorWarning?.size > 0) {
            tsunamiBadges.push({ label: '大津波警報', class: 'tsunami-major-warning' });
        }
        if (tsunamiData.areas.Warning?.size > 0) {
            tsunamiBadges.push({ label: '津波警報', class: 'tsunami-warning-detailed' });
        }
        if (tsunamiData.areas.Advisory?.size > 0) {
            tsunamiBadges.push({ label: '津波注意報', class: 'tsunami-advisory' });
        }
    }

    // 津波観測情報があればバッジを追加
    if (tsunamiObservationData && tsunamiObservationData.maxObservedHeight > 0) {
        tsunamiBadges.push({ label: '津波観測中', class: 'tsunami-observed' });
    }

    // 警報・注意報がない場合のフォールバック
    if (tsunamiBadges.length === 0) {
        if (detailedTsunamiGrade === 'None') {
            tsunamiBadges.push({ label: '津波なし', class: 'tsunami-none' });
        } else if (detailedTsunamiGrade === 'Checking') {
            tsunamiBadges.push({ label: '調査中', class: 'tsunami-checking' });
        }
    }
    
    // --- GAS送信用に最高レベルの津波ラベルをテキストとして追加 ---
    let tsunamiLabelForGas = '不明';
    if (tsunamiBadges.length > 0) {
        // 警報レベルが最も高いものが配列の先頭に来る想定
        tsunamiLabelForGas = tsunamiBadges[0].label;
    } else {
        // フォールバック
        if (detailedTsunamiGrade === 'None') tsunamiLabelForGas = '津波なし';
        else if (detailedTsunamiGrade === 'Checking') tsunamiLabelForGas = '調査中';
    }
    // ---------------------------------------------------------

    // 津波予報のエリア情報を取得
    const tsunamiForecastAreas = tsunamiData ? {
        'MajorWarning': Array.from(tsunamiData.areas.MajorWarning || []),
        'Warning': Array.from(tsunamiData.areas.Warning || []),
        'Advisory': Array.from(tsunamiData.areas.Advisory || [])
    } : null;

    // レポートに基づきマグニチュードの取得方法を修正
    const magValue = eqData.hypocenter?.magnitude;
    const magnitudeDisplay = (magValue !== undefined && magValue !== null && !isNaN(magValue)) 
        ? parseFloat(magValue).toFixed(1) 
        : '不明';

    // ★★★ 震度階級別に「観測点名」をグループ化する処理を追加 ★★★
    const shindoPoints = {
        '70': [], '60': [], '55': [], '50': [], '45': [], '40': [], '30': [], '20': [], '10': []
    };

    // ★★★ オリジナルの観測点名を保持しつつ、points配列を加工する ★★★
    const processedPoints = earthquake.points?.map(point => ({
        ...point,
        originalAddr: point.addr // オリジナルを保持
    })) || [];

    if (earthquake.points && Array.isArray(earthquake.points)) {
        earthquake.points.forEach(point => {
            // point.scale (e.g., 30) が shindoPoints のキーとして存在するかチェック
            if (shindoPoints.hasOwnProperty(point.scale)) {
                // 都道府県名と観測点名をアンダースコアで連結してリストに追加
                const formattedPointName = `${point.pref}_${point.addr}`;
                shindoPoints[point.scale].push(formattedPointName);
            }
        });
    }

    // 必要な情報を整形して返す。pointsデータはrawPointsとして保存し、描画時に処理する
    return {
        id: syntheticId,
        time: formatDateTime(earthquake.earthquake.time), // ★表示も地震発生時刻に変更
        epicenter: epicenterName, // ★★★ 修正 ★★★
        depth: eqData.hypocenter?.depth, // ★★★ 修正: 震源の深さを追加 (Optional Chaining) ★★★
        magnitude: magnitudeDisplay,
        tsunami: earthquake.earthquake.domesticTsunami, // 津波の有無を追加
        tsunamiLabel: tsunamiLabelForGas, // ★★★ GAS送信用に追加 ★★★
        tsunamiBadges: tsunamiBadges, // 複数の津波バッジ情報を保持
        tsunamiObservation: tsunamiObservationData, // 津波観測情報を追加
        tsunamiForecastAreas: tsunamiForecastAreas, // 津波予報エリア情報を追加
        maxShindoLabel: scaleToShindo(earthquake.earthquake.maxScale).label,
        maxShindoClass: scaleToShindo(earthquake.earthquake.maxScale).class,
        maxScale: earthquake.earthquake.maxScale, // 最大震度を数値で保持
        points: processedPoints, // ★★★ 加工済みの観測点データを保持 ★★★
        shindoPoints: shindoPoints, // ★★★ グループ化した観測点データを追加 ★★★
    };
};


// --- UIレンダリングロジック ---

// 最後に選択されたカードのIDを保持
let selectedCardId = null;

/**
 * 震度ラベルの文字列からクラス名を取得する
 */
const shindoLabelToClass = (label) => {
    // ラベルが「震度」で始まっているため、クラスマップのキーも更新
    const classMap = {
        '震度7': 'shindo-7', '震度6強': 'shindo-6-plus', '震度6弱': 'shindo-6-minus', 
        '震度5強': 'shindo-5-plus', '震度5弱': 'shindo-5-minus', '震度4': 'shindo-4',
        '震度3': 'shindo-3', '震度2': 'shindo-2', '震度1': 'shindo-1',
        '概況': 'bg-gray-500 text-white', // 概況ビュー用
        '情報なし': 'bg-gray-600 text-white', // データなし用
        '不明': 'bg-gray-400 text-white'
    };
    // 実際のラベルは '震度7' などの形式になっているため、ここでクラスを取得する
    return classMap[label] || 'bg-gray-400 text-white';
};

/**
 * 地震観測点データを震度と表示モードに基づいてグループ化する
 * @param {Array} rawPoints - 地震情報オブジェクトの points 配列
 * @param {string} mode - 'point' (観測点別) または 'municipality' (市区町村別)
 * @returns {Array} 震度別・モード別にグループ化されたデータ
 */
const groupPointsByShindoAndMode = (rawPoints, mode, minScale) => {
    const shindoGroup = {}; 

    if (!rawPoints || !Array.isArray(rawPoints)) return [];

    rawPoints.forEach(point => {
        // 指定された最低震度以上の観測点を含める
        if (point.scale >= minScale) {
            const shindoLabel = scaleToShindo(point.scale).label;
            
            let name;
            if (mode === 'municipality') {
                name = getMunicipality(point.addr, point.pref); // 市区町村名に絞り込み（区まで含む）
            } else {
                name = point.addr || '観測点名不明'; // 観測点名全体
            }

            if (!shindoGroup[shindoLabel]) {
                shindoGroup[shindoLabel] = new Set(); // 重複防止のためにSetを使用
            }
            shindoGroup[shindoLabel].add(name);
        }
    });

    // 震度ラベルを降順にソート
    const sortedShindoKeys = Object.keys(shindoGroup).sort((a, b) => {
        return (SHINDO_SORT_ORDER[b] || 0) - (SHINDO_SORT_ORDER[a] || 0);
    });
    
    // SetをArrayに変換する（並べ替えは行わない）
    return sortedShindoKeys.map(key => ({
        shindo: key,
        cities: Array.from(shindoGroup[key])
    }));
};


/**
 * 地震一覧のリストアイテムをレンダリングする
 * @param {Object} eq - 整形済み地震情報オブジェクト
 * @returns {string} HTML文字列
 */
const renderEarthquakeListItem = (eq) => {
    // ダークモード対応: p-3 -> py-3 px-2 に変更 (左右のパディングを半減)
    return `
        <div id="card-${eq.id}"
             class="earthquake-card relative py-3 px-2 rounded-lg shadow-sm border-l-4 border-gray-700 bg-gray-700 hover:bg-gray-600 transition duration-150 cursor-pointer"
             data-event-id="${eq.id}">
            <span id="on-air-${eq.id}" class="on-air-badge hidden">ON AIR</span>
            <div class="flex justify-between items-start">
                <div class="flex-grow truncate pr-2 pl-12">
                    <p class="text-sm font-medium text-gray-100">${eq.epicenter}</p>
                    <p class="text-xs text-gray-400">${eq.time}</p>
                </div>
                <div class="flex flex-col items-end space-y-1 flex-shrink-0">
                    <span class="shindo-badge text-xs ${eq.maxShindoClass}">${eq.maxShindoLabel}</span>
                    <div class="flex space-x-1 mt-1">
                        ${eq.tsunamiBadges.map(badge => `
                            <span class="tsunami-badge list-tsunami-badge ${badge.class}">${badge.label}</span>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>
    `;
};

/**
 * 地震詳細パネルの内容をレンダリングする
 * @param {Object} eq - 整形済み地震情報オブジェクト
 */
const displayEarthquakeDetails = (eq) => {
    const detailContainer = document.getElementById('detail-content');
    const detailTitle = document.getElementById('detail-panel-title');
    
    // データ存在の防御的チェック
    if (!eq || !eq.points) {
         // ダークモード対応: text-gray-500 -> text-gray-400
         detailContainer.innerHTML = `
            <div class="text-center p-8 text-gray-400">
                <svg class="w-12 h-12 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h18M3 8h18m-6 4h6m-6 4h6M3 12h2M3 16h2"></path></svg>
                <p>この地震の詳細データは読み込めませんでした。リストから再度選択してください。</p>
            </div>
        `;
        console.error('Error: Earthquake data or points is missing.', eq);
        // 固定バーもクリア
        detailTitle.textContent = '地震詳細'; // タイトルをリセット
        updateFixedShindoBar(null);
        return;
    }

    // 津波の有無に応じてタイトルを変更
    const hasTsunamiWarning = eq.tsunamiBadges.some(b => ['大津波警報', '津波警報', '津波注意報', '津波観測中'].includes(b.label));
    if (hasTsunamiWarning) {
        detailTitle.textContent = '地震・津波詳細';
    } else {
        detailTitle.textContent = '地震詳細';
    }

    // 現在のDISPLAY_MODEに基づいてデータをグループ化
    const shindoByMode = groupPointsByShindoAndMode(eq.points, DISPLAY_MODE, CONFIG.MIN_DETAIL_SCALE);

    // ★★★ 追加: ふりがな不明の市区町村を手動辞書に自動登録する ★★★
    if (DISPLAY_MODE === 'municipality') {
        let dictionaryUpdated = false;
        shindoByMode.forEach(item => {
            item.cities.forEach(cityKey => { // cityKeyは "都道府県名_市区町村名" の形式
                const kana = getKana(cityKey);
                // ふりがながなく、手動辞書にキーが存在しないか、値が空の場合
                if (!kana && (MANUAL_KANA_DICT[cityKey] === undefined || MANUAL_KANA_DICT[cityKey] === '') && !cityKey.includes('不明')) {
                    MANUAL_KANA_DICT[cityKey] = ''; // 空の値で登録
                    dictionaryUpdated = true;
                    console.log(`ふりがな不明の市区町村を辞書候補に追加: ${cityKey}`);
                }
            });
        });

        // 辞書が更新された場合、ローカルストレージに保存する
        if (dictionaryUpdated) {
            localStorage.setItem('manualKanaDictionary', JSON.stringify(MANUAL_KANA_DICT));
        }
    }

    // 詳細セクションの震度別リストを生成
    const detailList = shindoByMode.map(item => {
        // ★★★ 修正: 市区町村モードの場合にふりがな付きのHTMLを生成 ★★★
        const citiesHtml = item.cities.map(city => {
            if (DISPLAY_MODE === 'municipality') {
                const [pref, municipality] = city.split('_');
                const kana = getKana(city); // getKanaは "pref_city" 形式を処理できる
                // ふりがな用のdivと地名用のspanを一つのブロックとして扱う
                return `
                    <div class="inline-block text-center mx-1 mb-2 align-bottom">
                        <div class="text-xs text-gray-300" style="height: 1em;">${kana || '&nbsp;'}</div>
                        <span class="font-semibold">${municipality}</span>
                    </div>
                `;
            } else {
                // 観測点モードの場合はこれまで通り
                return `<span class="inline-block font-semibold">${city}</span>`;
            }
        }).join(DISPLAY_MODE === 'municipality' ? '' : '　');

        return `
            <div class="mb-4 p-4 bg-gray-700 rounded-lg border border-gray-600">
                <div class="flex items-center mb-2">
                    <span class="shindo-badge ${shindoLabelToClass(item.shindo)} text-base">${item.shindo}</span>
                    <span class="text-sm text-gray-400 ml-4">（${item.cities.length} 地域）</span>
                </div>
                <p class="text-lg text-gray-200 leading-relaxed pt-2 mt-2 border-t border-gray-600 city-list-no-break">
                    ${citiesHtml}
                </p>
            </div>
        `;
    }).join('');

    // ラベルを '市区町村別' または '観測点別' に統一
    const modeLabel = DISPLAY_MODE === 'municipality' ? '市区町村別' : '観測点別'; 

    const html = `
        <div class="flex items-center justify-between mb-4 gap-4">
            <h3 class="text-2xl font-bold text-white">${eq.epicenter}</h3>
            <div class="flex items-center gap-4 flex-shrink-0">
                <button id="generate-script-button" class="px-3 py-1.5 text-sm font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800">
                    放送原稿を作成
                </button>
                <span class="shindo-badge ${eq.maxShindoClass} text-base whitespace-nowrap">${eq.maxShindoLabel}</span>
            </div>
        </div>
        <!-- ダークモード対応: text-gray-600 -> text-gray-300, border-b -> border-b border-gray-700 -->
        <div class="flex flex-wrap gap-x-6 gap-y-2 mb-6 text-sm text-gray-300 border-b border-gray-700 pb-4">
            <p><strong>発生日時:</strong> ${eq.time}</p>
            <p><strong>震源の深さ:</strong> ${eq.depth === 0 ? 'ごく浅い' : (eq.depth > 0 ? `約${eq.depth}km` : '不明')}</p>
            <p><strong>マグニチュード:</strong> M${eq.magnitude}</p>
            <p><strong>津波の有無:</strong> 
                ${(() => {
                    // 最高レベルの警報を基準にメッセージを決定
                    const highestTsunami = eq.tsunamiBadges[0] || {};
                    switch (highestTsunami.label) {
                        case '大津波警報': return '<span class="font-bold text-purple-400">大津波警報を発表中です</span>';
                        case '津波警報': return '<span class="font-bold text-red-500">津波警報を発表中です</span>';
                        case '津波注意報': return '<span class="font-bold text-yellow-400">津波注意報を発表中です</span>';
                        case '津波観測中': return `<span class="font-bold text-purple-400">津波を観測中です (最大 ${eq.tsunamiObservation?.maxObservedHeight || '?'}m)</span>`;
                        case '津波なし': return 'この地震による津波の心配はありません';
                        case '調査中': return '現在 気象庁が調査中です';
                        default: return '不明';
                    }
                })()}
            </p>
        </div>
        
        ${(() => {
            if (!eq.tsunamiForecastAreas || (eq.tsunamiForecastAreas.MajorWarning.length === 0 && eq.tsunamiForecastAreas.Warning.length === 0 && eq.tsunamiForecastAreas.Advisory.length === 0)) {
                return '';
            }
            const renderAreaList = (areas, title, badgeClass) => {
                if (!areas || areas.length === 0) return '';
                return `
                    <div class="mt-3">
                        <h5 class="flex items-center text-base font-bold text-gray-200 mb-2">
                            <span class="tsunami-badge ${badgeClass} mr-2">${title}</span>
                            <span>発表中の沿岸</span>
                        </h5>
                        <p class="text-lg font-semibold text-gray-200 leading-relaxed city-list-no-break">
                            ${areas.join('　')}
                        </p>
                    </div>
                `;
            };
            return `
                ${renderAreaList(eq.tsunamiForecastAreas.MajorWarning, '大津波警報', 'tsunami-major-warning')}
                ${renderAreaList(eq.tsunamiForecastAreas.Warning, '津波警報', 'tsunami-warning-detailed')}
                ${renderAreaList(eq.tsunamiForecastAreas.Advisory, '津波注意報', 'tsunami-advisory')}
            `;
        })()}
        ${(() => {
            if (!eq.tsunamiForecastAreas || (eq.tsunamiForecastAreas.MajorWarning.length === 0 && eq.tsunamiForecastAreas.Warning.length === 0 && eq.tsunamiForecastAreas.Advisory.length === 0)) return '';
            return '<hr class="my-6 border-gray-600">';
        })()}

        ${(() => {
            if (!eq.tsunamiObservation || !eq.tsunamiObservation.stations || eq.tsunamiObservation.stations.length === 0) {
                return '';
            }
            const sortedStations = [...eq.tsunamiObservation.stations].sort((a, b) => b.height - a.height);
            const stationList = sortedStations.map(station => {
                const heightText = station.height >= 10 ? `${station.height.toFixed(1)}m以上` : `${station.height.toFixed(1)}m`;
                const timeText = formatDateTime(station.time).split(' ')[1]; // HH:mm
                return `
                    <div class="flex justify-between items-baseline py-1 border-b border-gray-700">
                        <span class="text-lg font-semibold text-gray-200">${station.name}</span>
                        <span class="text-lg font-bold text-red-400">${heightText} <span class="text-xs text-gray-400 font-normal">(${timeText})</span></span>
                    </div>
                `;
            }).join('');

            return `
                <h5 class="flex items-center text-base font-bold text-gray-200 mb-2 mt-6">
                    <span class="tsunami-badge tsunami-observed mr-2">津波観測情報</span>
                </h5>
                <div class="space-y-1">${stationList}</div>
                <hr class="my-6 border-gray-600">
            `;
        })()}

        <!-- ダークモード対応: text-gray-700 -> text-gray-200 -->
        <h4 class="text-lg font-bold text-gray-200 mb-3">震度別観測地点 (${modeLabel})</h4>
        <!-- ダークモード対応: text-gray-500 -> text-gray-400 -->
        ${shindoByMode.length > 0 ? detailList : '<p class="text-sm text-gray-400">観測データがありません。</p>'}
    `;

    detailContainer.innerHTML = html;
    
    // --- 固定バーの更新 ---
    updateFixedShindoBar(eq);

    // --- 放送原稿作成ボタンのイベントリスナーを設定 ---
    const generateScriptButton = document.getElementById('generate-script-button');
    if (generateScriptButton) {
        generateScriptButton.addEventListener('click', () => generateAndShowBroadcastScript(eq));
    }
};


/**
 * 全ての地震情報をリストコンテナに表示し、イベントリスナーを設定する
 * @param {Array} processedEarthquakes - 処理済みの地震情報配列
 */
const displayEarthquakes = (processedEarthquakes) => {
    const listContainer = document.getElementById('earthquake-list');
    const noDataElement = document.getElementById('no-data');
    listContainer.innerHTML = '';
    
    // 選択状態をリセット
    selectedCardId = null;

    if (processedEarthquakes.length === 0) {
        noDataElement.classList.remove('hidden');
         // データがない場合は詳細パネルと固定バーを初期状態に戻す
        document.getElementById('detail-content').innerHTML = `
            <div class="text-center p-8 text-gray-400">
                <svg class="w-12 h-12 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h18M3 8h18m-6 4h6m-6 4h6M3 12h2M3 16h2"></path></svg>
                <p>左側のリストから地震を選択してください。</p>
            </div>
        `;
        updateFixedShindoBar(null); // 固定バーをクリア
        return;
    }
    
    noDataElement.classList.add('hidden');
    
    // リストアイテムHTMLを生成して挿入
    const cardsHtml = processedEarthquakes.map(renderEarthquakeListItem).join('');
    listContainer.innerHTML = cardsHtml;

    // イベントリスナーの設定
    listContainer.querySelectorAll('.earthquake-card').forEach(card => {
        
        card.addEventListener('click', (e) => {
            const clickedCard = e.currentTarget;
            const eventId = clickedCard.getAttribute('data-event-id');
            
            // --- 選択状態のハイライトを解除 ---
            document.querySelectorAll('.earthquake-card.selected').forEach(selectedCard => {
                // ダークモード対応: 選択解除時のクラス変更
                selectedCard.classList.remove('selected', 'border-blue-400', 'bg-blue-900/50');
                selectedCard.classList.add('border-gray-700', 'bg-gray-700');
            });
            
            // PROCESSED_EARTHQUAKES内のIDは既に文字列なので、厳密比較で正しいデータを取得
            const eqData = PROCESSED_EARTHQUAKES.find(eq => eq.id === eventId); 

            // 今回クリックされたカードを選択状態にする (ダークモード対応)
            clickedCard.classList.add('selected', 'border-blue-400', 'bg-blue-900/50');
            clickedCard.classList.remove('border-gray-700', 'bg-gray-700');
            
            selectedCardId = clickedCard.id;

            // 詳細パネルの表示
            displayEarthquakeDetails(eqData);
        });
    });
    
    // 最初の地震を自動的に選択し、詳細を直接表示する
    if (processedEarthquakes.length > 0) {
        const firstEq = processedEarthquakes[0];
        const firstCardId = `card-${firstEq.id}`;
        const firstCard = document.getElementById(firstCardId);

        if (firstCard) {
            // ハイライトを設定 (ダークモード対応)
            firstCard.classList.add('selected', 'border-blue-400', 'bg-blue-900/50');
            firstCard.classList.remove('border-gray-700', 'bg-gray-700');
            selectedCardId = firstCard.id;
            
            // 詳細を直接表示
            displayEarthquakeDetails(firstEq);
        } else {
            // 要素が見つからなかった場合でも、データがあれば詳細表示だけは試みる
            displayEarthquakeDetails(firstEq);
        }
    }
};

/**
 * データを手動で更新する（API呼び出しとUI再描画）
 */
const refreshData = async () => {
    // ループ再生中はAPIの自動更新をスキップする
    if (isAutoplaying) return;

    const refreshButton = document.getElementById('refresh-button');
    const buttonTextSpan = document.getElementById('refresh-text');
    const fetchTimeDisplay = document.getElementById('fetch-time-display');
    
    // 更新前の地震IDリストを保持
    const idsBefore = PROCESSED_EARTHQUAKES.map(eq => eq.id).sort();

    if (!refreshButton || !buttonTextSpan || !fetchTimeDisplay) return;

    // 1. Loading/Disable state
    refreshButton.disabled = true;
    refreshButton.classList.add('opacity-50', 'cursor-not-allowed');
    const originalText = buttonTextSpan.textContent;

    // 2. Fetch and Display
    const earthquakes = await fetchEarthquakeData();
    displayEarthquakes(earthquakes);

    // 3. 地震データに変化があったかチェックし、自動再生を開始
    const idsAfter = earthquakes.map(eq => eq.id).sort();
    const hasChanged = JSON.stringify(idsBefore) !== JSON.stringify(idsAfter);

    if (hasChanged && !isAutoplaying) {
        // 新しい地震がリストの先頭に来るように、displayEarthquakesがソートしていることを前提とする
        if (earthquakes.length > 0) {
            isWaitingForAutoplay = true; // 自動再生待機フラグを立てる
            // 詳細パネルと固定バーのビューは更新するが、表示はさせない
            const eqData = earthquakes[0];
            updateFixedShindoBar(eqData);
            updateNavControls({}, null); // isWaitingForAutoplayフラグを元に「地震 受信中」を表示させる
            console.log('新しい地震データを検知しました。3秒後に自動再生を開始します。');
            setTimeout(startAutoplay, 3000); // 3秒待ってから自動再生を開始
        }
    }

    // 3. API取得に成功し、UIが更新された場合（エラーメッセージが表示されていない場合）のみ、取得日時を更新
    const isErrorDisplayed = !document.getElementById('error-message').classList.contains('hidden');

    if (!isErrorDisplayed) {
        // 日本時間として現在時刻を取得し、フォーマット
        const now = new Date(); 
        LAST_FETCH_TIME = formatCurrentTime(now);
        fetchTimeDisplay.textContent = `最終取得日時: ${LAST_FETCH_TIME}`;
    }

    // 4. Complete state
    buttonTextSpan.textContent = '更新完了!'; // 一時的に更新完了を表示

    // 5. Re-enable and reset text
    setTimeout(() => {
        buttonTextSpan.textContent = originalText; // 元のテキストに戻す ('API更新')
        refreshButton.disabled = false;
        refreshButton.classList.remove('opacity-50', 'cursor-not-allowed');
    }, 1000);
};


// --- 固定フッターのロジック ---

/**
 * 固定フッター（配信画面用）を更新する
 * @param {Object} eq - 現在選択されている地震情報オブジェクト
 */
const updateFixedShindoBar = (eq) => {
    const shindoNav = document.getElementById('shindo-nav');

    if (!eq || !eq.points) {
        // 初期状態 / データなし
        // 初期状態 / データなし / 自動再生待機中ではない
        FIXED_BAR_VIEWS = [];
        shindoNav.style.display = 'none';
        displayInitialFixedBarState();
        // 自動再生待機中でなければ停止する
        if (!isWaitingForAutoplay) {
            pauseAutoplay();
        }
        return;
    }
    
    const contentLine1 = document.getElementById('content-line-1');
    const shindoGroups = groupPointsByShindoAndMode(eq.points, 'municipality', loopPlaybackMinScale);
    FIXED_BAR_VIEWS = []; 
    
    // --- 1. 概況ページの生成 (指定箇所での分割ロジック) ---
    const [datePart, timePart] = eq.time.split(' '); // "YYYY/MM/DD", "HH:mm"
    const today = new Date();
    const eqDate = new Date(datePart);
    let displayTime;
    const formattedTimeForTelop = formatTimeForTelop(timePart); // 「午前/午後 X時Y分」形式

    if (today.getFullYear() === eqDate.getFullYear() &&
        today.getMonth() === eqDate.getMonth() &&
        today.getDate() === eqDate.getDate()) {
        displayTime = `${formattedTimeForTelop}ごろ`; // 今日の場合は時刻のみ
    } else {
        const [_, month, day] = datePart.split('/');
        displayTime = `${parseInt(month, 10)}月${parseInt(day, 10)}日 ${formattedTimeForTelop}ごろ`; // 今日でない場合は日付も表示
    }

    // 1-1. 地震発生情報のページ生成
    const text1 = `${displayTime} ${eq.epicenter}を震源とする 最大${eq.maxShindoLabel}の地震がありました`;
    if (!doesTextFitInTwoLines(text1, contentLine1)) {
        const part1 = `${displayTime} ${eq.epicenter}を震源とする`;
        const part2 = `最大${eq.maxShindoLabel}の地震がありました`;
        FIXED_BAR_VIEWS.push({ type: 'summary', shindo: '概況', line1: part1, line2: '', shindoClass: 'bg-gray-500 text-white' });
        FIXED_BAR_VIEWS.push({ type: 'summary', shindo: '概況', line1: part2, line2: '', shindoClass: 'bg-gray-500 text-white' });
    } else {
        FIXED_BAR_VIEWS.push({ type: 'summary', shindo: '概況', line1: text1, line2: '', shindoClass: 'bg-gray-500 text-white' });
    }

    // 1-2. 震源・マグニチュード情報のページ生成
    if (eq.magnitude !== '不明') {
        const depthText = eq.depth === 0 ? ' ごく浅い　' : (eq.depth > 0 ? `およそ${eq.depth}km　` : '不明');
        const magnitudeText = `地震の規模は マグニチュード${eq.magnitude}`;
        const text2 = `震源の深さは${depthText}${magnitudeText}`;
        if (!doesTextFitInTwoLines(text2, contentLine1)) {
            const part1 = `震源の深さは${depthText.trim()}`;
            const part2 = magnitudeText;
            FIXED_BAR_VIEWS.push({ type: 'summary', shindo: '概況', line1: part1, line2: '', shindoClass: 'bg-gray-500 text-white' });
            FIXED_BAR_VIEWS.push({ type: 'summary', shindo: '概況', line1: part2, line2: '', shindoClass: 'bg-gray-500 text-white' });
        } else {
            FIXED_BAR_VIEWS.push({ type: 'summary', shindo: '概況', line1: text2, line2: '', shindoClass: 'bg-gray-500 text-white' });
        }
    }

    // 3. 津波情報 (利用可能な場合) - 概況ページが生成された後に挿入
    if (eq.tsunamiLabel) {
        let tsunamiMessage = '';
        switch (eq.tsunamiLabel) {
            case '大津波警報':
                tsunamiMessage = 'この地震で 大津波警報 が発表されています'; // この文言は変更しない
                break;
            case '津波警報':
                tsunamiMessage = 'この地震で 津波警報 が発表されています'; // この文言は変更しない
                break;
            case '津波注意報':
                tsunamiMessage = 'この地震で 津波注意報 が発表されています'; // この文言は変更しない
                break;
            case '調査中':
                tsunamiMessage = '現在 気象庁が調査中です'; // この文言は変更しない
                break;
            case '津波なし':
                tsunamiMessage = 'この地震による津波の心配はありません';
                break;
        }

        if (tsunamiMessage) {
            let badgeLabel = eq.tsunamiLabel;
            let badgeClass = eq.tsunamiClass;

            // 固定フッター表示時のみ、「津波なし」「調査中」のバッジを「津 波」に変更し、スタイルを分岐
            if (eq.tsunamiLabel === '津波なし' || eq.tsunamiLabel === '調査中') {
                badgeLabel = '津 波';
                // 「津 波」バッジは角丸長方形にするため、tsunami-telop-badge を付けない
                badgeClass = 'tsunami-none'; 
            } else {
                // 大津波警報・津波警報・津波注意報の場合は長方形にするクラスを追加
                badgeClass = `${badgeClass} tsunami-telop-badge`;
            }

            FIXED_BAR_VIEWS.push({
                type: 'summary', // 概況と同じタイプ
                shindo: badgeLabel,
                line1: tsunamiMessage,
                line2: '',
                shindoClass: badgeClass || 'bg-gray-500 text-white'
            });
        }
    }

    // 津波予報エリアのページを生成
    if (eq.tsunamiForecastAreas) {
        const createTsunamiAreaViews = (areas, title, badgeClass) => {
            if (!areas || areas.length === 0) return;

            let pageAreas = [];
            for (let i = 0; i < areas.length; i++) {
                const testAreas = [...pageAreas, areas[i]];
                const testHtml = `${testAreas.join('　')}`;
                if (!doesTextFitInTwoLines(testHtml, contentLine1) && pageAreas.length > 0) {
                    FIXED_BAR_VIEWS.push({ type: 'summary', shindo: title, line1: `${pageAreas.join('　')}`, line2: '', shindoClass: `${badgeClass} tsunami-telop-badge` });
                    pageAreas = [areas[i]];
                } else {
                    pageAreas.push(areas[i]);
                }
            }
            if (pageAreas.length > 0) {
                FIXED_BAR_VIEWS.push({ type: 'summary', shindo: title, line1: `${pageAreas.join('　')}`, line2: '', shindoClass: `${badgeClass} tsunami-telop-badge` });
            }
        };

        // 警報レベルの高い順にページを生成
        createTsunamiAreaViews(eq.tsunamiForecastAreas.MajorWarning, '大津波警報', 'tsunami-major-warning');
        createTsunamiAreaViews(eq.tsunamiForecastAreas.Warning, '津波警報', 'tsunami-warning-detailed');
        createTsunamiAreaViews(eq.tsunamiForecastAreas.Advisory, '津波注意報', 'tsunami-advisory');
    }

    // 津波観測情報のページを生成
    if (eq.tsunamiObservation && eq.tsunamiObservation.stations && eq.tsunamiObservation.stations.length > 0) {
        const sortedStations = [...eq.tsunamiObservation.stations].sort((a, b) => b.height - a.height);
        let pageStations = [];
        for (const station of sortedStations) {
            const heightText = station.height >= 10 ? `${station.height.toFixed(1)}m以上` : `${station.height.toFixed(1)}m`;
            const stationText = `<span class="inline-block">${station.name} ${heightText}</span>`;
            const testHtml = [...pageStations, stationText].join('　');
            if (!doesTextFitInTwoLines(testHtml, contentLine1) && pageStations.length > 0) {
                FIXED_BAR_VIEWS.push({ type: 'shindo', shindo: '津波観測中', line1: pageStations.join('　'), line2: '', shindoClass: 'tsunami-observed' });
                pageStations = [stationText];
            } else {
                pageStations.push(stationText);
            }
        }
        if (pageStations.length > 0) FIXED_BAR_VIEWS.push({ type: 'shindo', shindo: '津波観測中', line1: pageStations.join('　'), line2: '', shindoClass: 'tsunami-observed' });
    }


    // --- 4. 「各地の震度は〜」ページの生成 ---
    const finalTextView = { type: 'summary', shindo: '震度情報', line1: '各地の震度は次のとおりです', line2: '', shindoClass: 'bg-gray-500 text-white' };
    FIXED_BAR_VIEWS.push(finalTextView);

    // --- 5. 震度別地域ページの生成 (動的ページ分割) ---
    shindoGroups.forEach(group => {
        const cities = group.cities;
        let pageCities = [];

        for (let i = 0; i < cities.length; i++) {
            // ★★★ 修正: 表示用に市区町村名のみを抽出する ★★★
            const cityName = cities[i].includes('_') ? cities[i].split('_')[1] : cities[i];
            const testCities = [...pageCities, cityName];
            const testHtml = testCities.map(c => `<span class="inline-block">${c}</span>`).join('　');

            if (!doesTextFitInTwoLines(testHtml, contentLine1) && pageCities.length > 0) {
                // 収まらなくなったので、直前までの内容でページを作成
                // ★★★ 修正: pageCitiesには既に整形済みの名前が入っている ★★★
                const pageHtml = pageCities.map(c => `<span class="inline-block">${c}</span>`).join('　');
                FIXED_BAR_VIEWS.push({ type: 'shindo', shindo: group.shindo, line1: pageHtml, line2: '', shindoClass: shindoLabelToClass(group.shindo) });
                // 新しいページを開始
                pageCities = [cityName];
            } else {
                pageCities.push(cityName);
            }
        }
        // ループ終了後、残りの市区町村で最後のページを作成
        if (pageCities.length > 0) {
            // ★★★ 修正: pageCitiesには既に整形済みの名前が入っている ★★★
            const pageHtml = pageCities.map(c => `<span class="inline-block">${c}</span>`).join('　');
            FIXED_BAR_VIEWS.push({ type: 'shindo', shindo: group.shindo, line1: pageHtml, line2: '', shindoClass: shindoLabelToClass(group.shindo) });
        }
    });

    // --- 6. 全てのビューにページ番号を付与 ---
    const totalViews = FIXED_BAR_VIEWS.length;
    FIXED_BAR_VIEWS.forEach((view, index) => {
        view.pageCurrent = index + 1;
        view.pageTotal = totalViews;
    });

    // --- 7. 表示を更新 ---
    CURRENT_SHINDO_INDEX = 0; 

    // 地震を選択したら、コントロールボタンを表示し、表示エリアをクリアする
    const autoplayControls = document.getElementById('autoplay-controls');
    const line1 = document.getElementById('content-line-1');
    const currentShindoLabel = document.getElementById('current-shindo-label');

    if (FIXED_BAR_VIEWS.length > 1) {
        autoplayControls.style.display = 'flex';
        document.getElementById('reset-display-button').style.display = 'block';
        document.getElementById('transition-controls').style.display = 'flex';
        shindoNav.style.display = 'flex';
    } else {
        autoplayControls.style.display = 'none';
        document.getElementById('reset-display-button').style.display = 'none';
        document.getElementById('transition-controls').style.display = 'none';
        shindoNav.style.display = 'none';
    }

    // 表示エリアをクリア
    line1.textContent = '';
    document.getElementById('content-line-2').textContent = '';
    currentShindoLabel.classList.add('hidden');
};

/**
 * 固定フッターを初期状態に戻す
 */
const displayInitialFixedBarState = () => {
    const line1 = document.getElementById('content-line-1');
    const line2 = document.getElementById('content-line-2');
    const currentShindoLabel = document.getElementById('current-shindo-label');
    const shindoNav = document.getElementById('shindo-nav');
    const autoplayControls = document.getElementById('autoplay-controls');
    const transitionControls = document.getElementById('transition-controls');
    const resetButton = document.getElementById('reset-display-button');
    const pageInfo = document.getElementById('shindo-page-info');

    // 変更: テキストとバッジを非表示にする
    line1.textContent = '';
    line2.textContent = '';
    currentShindoLabel.classList.add('hidden'); // バッジを隠す
    shindoNav.style.display = 'none';
    autoplayControls.style.display = 'none';
    transitionControls.style.display = 'none';
    resetButton.style.display = 'none';
    pageInfo.textContent = '';
}

/**
 * 震度3以上の観測地点がない場合の固定フッター表示
 */
const displayFixedBarNoShindoData = () => {
     const line1 = document.getElementById('content-line-1');
     const line2 = document.getElementById('content-line-2');
     const currentShindoLabel = document.getElementById('current-shindo-label');
     const eq = PROCESSED_EARTHQUAKES.find(e => e.id === selectedCardId.substring(5));

     line1.innerHTML = `<span class="text-white">${eq.epicenter}</span> (M${eq.magnitude}, ${eq.time})`;
     line2.textContent = '震度3以上の観測地点情報はありません。';
     currentShindoLabel.textContent = '震度情報なし';
     currentShindoLabel.className = 'shindo-badge text-sm h-7 flex items-center bg-gray-600 text-white';
}


/**
 * 固定フッター内の震度グループ表示を切り替える
 */
const updateFixedBarDisplay = (overrideView = null, direction = 'none') => {
    const line1 = document.getElementById('content-line-1');
    const line2 = document.getElementById('content-line-2');
    const animationWrapper = document.getElementById('animation-wrapper'); // キャッシュ
    const contentWrapper = document.getElementById('content-wrapper');     // キャッシュ
    const prevButton = document.getElementById('shindo-prev');           // キャッシュ
    const nextButton = document.getElementById('shindo-next');           // キャッシュ
    const pageInfo = document.getElementById('shindo-page-info');        // キャッシュ

    // ★★★ 修正: 古い変数名 `fixedBarState` を `FIXED_BAR_VIEWS` に修正 ★★★
    if (FIXED_BAR_VIEWS.length === 0 && !overrideView) return;

    // ★★★ 修正: 古い変数名 `fixedBarState` を `FIXED_BAR_VIEWS` と `CURRENT_SHINDO_INDEX` に修正 ★★★
    const currentView = overrideView || FIXED_BAR_VIEWS[CURRENT_SHINDO_INDEX];

    const transitionEffect = document.getElementById('transition-effect').value;

    // --- アニメーション処理 ---
    if (transitionEffect === 'slide' && direction !== 'none' && !overrideView) {
        const outClass = direction === 'next' ? 'slide-out-left' : 'slide-out-right';
        const inClass = direction === 'next' ? 'slide-in-right' : 'slide-in-left';

        // 1. 現在のコンテンツをスライドアウト
        animationWrapper.classList.add(outClass);

        // 2. アニメーション終了後にコンテンツを更新してスライドイン
        setTimeout(() => {
            renderContent(currentView);
            animationWrapper.classList.remove(outClass);
            animationWrapper.classList.add(inClass);

            // 3. スライドインアニメーション終了後にクラスを削除
            setTimeout(() => {
                animationWrapper.classList.remove(inClass);
            }, 250);

        }, 250);

    } else {
        // カットチェンジ、または初回表示
        renderContent(currentView);
    }

    // --- ナビゲーションボタンとページ情報の更新 ---
    // ★★★ 修正: overrideView を正しく boolean に変換して渡す ★★★
    updateNavControls(currentView, overrideView ? true : false);
};

/**
 * コンテンツ描画部分を分離
 * @param {object} view - 表示するビューオブジェクト
 */
const renderContent = (view) => {
    const line1 = document.getElementById('content-line-1');
    const line2 = document.getElementById('content-line-2');
    const currentShindoLabel = document.getElementById('current-shindo-label');

    // 既存のスタイルをリセット
    line1.className = 'text-edge';
    line2.className = 'text-xs text-gray-400 hidden';

    // 震度ラベルを更新
    if (view.type === 'system') {
        currentShindoLabel.classList.add('hidden');
    } else {
        currentShindoLabel.classList.remove('hidden');
        currentShindoLabel.textContent = view.shindo;
        currentShindoLabel.className = 'shindo-badge text-3xl h-14 flex items-center justify-center flex-shrink-0 ml-1.5';
        currentShindoLabel.classList.add(...view.shindoClass.split(' '));
    }
    
    // コンテンツ行を更新
    line1.innerHTML = view.line1;
    line2.textContent = view.line2;

    // line1は常に表示、line2は基本非表示
    line1.classList.remove('hidden');
    line2.classList.add('hidden');
    
    // タイプに応じたスタイル適用
    if(view.type === 'summary') {
        line1.classList.add('text-4xl', 'font-bold', 'text-white');
        line1.classList.remove('truncate');
        line2.classList.remove('hidden');
        line2.textContent = view.line2;
    } else if (view.type === 'shindo') {
        line1.classList.add('text-4xl', 'font-bold', 'text-white');
        line1.classList.remove('truncate');
    } else if (view.type === 'system') {
        line1.classList.add('text-4xl', 'font-bold', 'text-white', 'text-center');
    }
};

/**
 * ナビゲーションコントロール（ボタン、ページ情報）の更新
 * @param {object} currentView - 現在のビュー
 * @param {object} overrideView - システムメッセージなどの一時ビュー
 */
const updateNavControls = (currentView, overrideView) => {
    const prevButton = document.getElementById('shindo-prev');
    const nextButton = document.getElementById('shindo-next');
    const pageInfo = document.getElementById('shindo-page-info');

    // ナビゲーションボタンの状態を更新

    // ページ情報の表示を更新
    if (isWaitingForAutoplay) {
        pageInfo.textContent = '地震 受信中';
        pageInfo.classList.remove('hidden');
    } else if (overrideView) {
        // ★★★ 修正: currentViewが存在し、かつページ情報を持っている場合のみ表示する ★★★
        if (currentView && currentView.pageCurrent !== undefined) {
        pageInfo.textContent = `${currentView.pageCurrent}${currentView.pageTotal}`;
        pageInfo.classList.remove('hidden');
        }
    } else if (currentView.pageTotal > 1) {
        let pageHTML = `<span class="inline-block">${currentView.pageCurrent}/${currentView.pageTotal}</span>`;
        if (isAutoplaying) {
            const loopsSelect = document.getElementById('autoplay-loops');
            const totalLoops = loopsSelect.value === 'Infinity' ? '∞' : loopsSelect.value;
            // ループカウンターは0から始まるので+1する
            const currentLoop = autoplayLoopCounter + 1;
            pageHTML += ` <span class="inline-block">L:${currentLoop}/${totalLoops}</span>`;
        }
        pageInfo.innerHTML = pageHTML;
        pageInfo.classList.remove('hidden');
    } else {
        pageInfo.textContent = '';
        pageInfo.classList.add('hidden');
    }
    prevButton.disabled = isAutoplaying || CURRENT_SHINDO_INDEX === 0;
    nextButton.disabled = isAutoplaying || CURRENT_SHINDO_INDEX === FIXED_BAR_VIEWS.length - 1;
};

// ナビゲーションボタンのイベントリスナー設定
const setupFixedBarNavigation = () => {
    document.getElementById('shindo-prev').addEventListener('click', () => {
        if (CURRENT_SHINDO_INDEX > 0) {
            pauseAutoplay(); // 手動操作で自動送りを停止
            CURRENT_SHINDO_INDEX--;
            updateFixedBarDisplay(null, 'prev');
        }
    });

    document.getElementById('shindo-next').addEventListener('click', () => {
        if (CURRENT_SHINDO_INDEX < FIXED_BAR_VIEWS.length - 1) {
            pauseAutoplay(); // 手動操作で自動送りを停止
            CURRENT_SHINDO_INDEX++;
            updateFixedBarDisplay(null, 'next');
        }
    });
};

/**
 * 手動ふりがな辞書リストをレンダリングする
 */
const renderManualKanaList = () => {
    const listWrapper = document.getElementById('manual-kana-list-wrapper');
    const noDataMessage = document.getElementById('no-manual-kana-message');

    // 子要素を全て削除（メッセージも含む）
    while (listWrapper.firstChild) {
        listWrapper.removeChild(listWrapper.firstChild);
    }

    const keys = Object.keys(MANUAL_KANA_DICT).sort();

    if (keys.length === 0) {
        listWrapper.appendChild(noDataMessage);
        return;
    }

    keys.forEach(key => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'flex justify-between items-center p-2 border-b border-gray-700 text-sm cursor-pointer hover:bg-gray-700/50 transition-colors';
        itemDiv.innerHTML = `
            <div class="flex-1 font-mono text-gray-300 mr-2">${key}</div>
            <div class="flex-1 font-mono text-green-400 mr-4">${MANUAL_KANA_DICT[key] || '<span class="text-yellow-400">未入力</span>'}</div>
            <button class="text-red-500 hover:text-red-400 font-bold text-xs">削除</button>
        `;

        itemDiv.addEventListener('click', (e) => {
            if (!e.target.classList.contains('text-red-500')) {
                if (kanaKeyInput && kanaValueInput) { // Ensure inputs are available
                    kanaKeyInput.value = key;
                    kanaValueInput.value = MANUAL_KANA_DICT[key];
                    kanaValueInput.focus();
                }
            }
        });

        itemDiv.querySelector('button').addEventListener('click', () => {
            delete MANUAL_KANA_DICT[key];
            renderManualKanaList();
        });
        listWrapper.appendChild(itemDiv);
    });
};

/**
 * 手動ふりがな辞書をJSONファイルとしてエクスポートする
 */
const exportKanaDictionaryToFile = () => {
    const dataStr = JSON.stringify(MANUAL_KANA_DICT, null, 2); // 読みやすいように整形
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'manual_kana_dictionary.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('手動ふりがな辞書をエクスポートしました。');
};

/**
 * JSONファイルから手動ふりがな辞書をインポートする
 * @param {File} file - インポートするファイルオブジェクト
 */
const importKanaDictionaryFromFile = (file) => {
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const importedDict = JSON.parse(event.target.result);
            // 簡易的なバリデーション: オブジェクトであり、キーと値が文字列であることを確認
            if (typeof importedDict === 'object' && importedDict !== null &&
                Object.keys(importedDict).every(key => typeof key === 'string' && typeof importedDict[key] === 'string')) {
                
                MANUAL_KANA_DICT = importedDict;
                localStorage.setItem('manualKanaDictionary', JSON.stringify(MANUAL_KANA_DICT));
                renderManualKanaList(); // リストを再描画
                console.log('手動ふりがな辞書をインポートしました。');
                alert('ふりがな辞書をインポートしました。');
            } else {
                throw new Error('ファイルの形式が正しくありません。');
            }
        } catch (e) {
            console.error('ふりがな辞書のインポートに失敗しました:', e);
            alert(`ふりがな辞書のインポートに失敗しました。\nエラー: ${e.message}`);
        }
    };
    reader.onerror = () => {
        console.error('ファイルの読み込み中にエラーが発生しました。');
        alert('ファイルの読み込み中にエラーが発生しました。');
    };
    reader.readAsText(file);
};

/**
 * 気象庁の定義ファイルから生成したふりがな辞書をJSONファイルとしてエクスポートする
 */
const exportJmaKanaDictionaryToFile = () => {
    // KANA_DICTが空の場合は警告を出す
    if (Object.keys(KANA_DICT).length === 0) {
        alert('気象庁のふりがな辞書がまだ生成されていません。ページをリロードして再試行してください。');
        return;
    }
    const dataStr = JSON.stringify(KANA_DICT, null, 2); // 読みやすいように整形
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jma_kana_dictionary.json'; // ファイル名
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('気象庁のふりがな辞書をエクスポートしました。');
};

/**
 * 手動ふりがな辞書モーダルのセットアップ
 */
const setupKanaDbModal = () => {
    const modal = document.getElementById('kana-db-modal');
    const openButton = document.getElementById('kana-db-button');
    const closeButton = document.getElementById('kana-db-modal-close');
    const saveButton = document.getElementById('kana-db-modal-save');
    const addButton = document.getElementById('add-kana-button');
    const keyInput = document.getElementById('new-kana-key');
    const valueInput = document.getElementById('new-kana-value');

    // グローバル変数に参照をセット
    kanaKeyInput = keyInput;
    kanaValueInput = valueInput;
    
    // ★★★ 修正: モーダルを開くイベントリスナーを追加 ★★★
    openButton.addEventListener('click', () => {
        renderManualKanaList();
        modal.classList.remove('hidden');
    });

    // モーダルを閉じる（保存しない）
    closeButton.addEventListener('click', () => {
        // 保存されていない変更を破棄するために、ローカルストレージから再読み込み
        loadManualKanaDict(); 
        modal.classList.add('hidden');
    });

    // 保存して閉じる
    saveButton.addEventListener('click', () => {
        localStorage.setItem('manualKanaDictionary', JSON.stringify(MANUAL_KANA_DICT));
        modal.classList.add('hidden');
        // 現在表示中の詳細を再描画して、ふりがなを即時反映
        if (selectedCardId) {
            const eventId = selectedCardId.substring(5);
            const eqData = PROCESSED_EARTHQUAKES.find(eq => eq.id === eventId);
            if (eqData) displayEarthquakeDetails(eqData);
        }
    });

    // 新規追加・更新
    addButton.addEventListener('click', () => {
        const key = kanaKeyInput.value.trim();
        const value = kanaValueInput.value.trim();
        if (key && value) {
            MANUAL_KANA_DICT[key] = value;
            kanaKeyInput.value = '';
            kanaValueInput.value = '';
            renderManualKanaList();
        }
    });
    
    // ★★★ 追加: エクスポート・インポートボタンのイベントリスナー ★★★
    const exportButton = document.getElementById('export-kana-button');
    const exportJmaButton = document.getElementById('export-jma-kana-button'); // ★★★ 追加 ★★★
    const importButton = document.getElementById('import-kana-button');
    const importFileInput = document.getElementById('import-kana-file-input');

    exportButton.addEventListener('click', exportKanaDictionaryToFile);

    exportJmaButton.addEventListener('click', exportJmaKanaDictionaryToFile); // ★★★ 追加 ★★★

    importButton.addEventListener('click', () => {
        importFileInput.click(); // 隠されたファイル入力要素をクリック
    });

    importFileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            importKanaDictionaryFromFile(file);
        }
        // ファイル選択ダイアログを再度開けるように、選択をクリア
        event.target.value = '';
    });
};

/**
 * 表示リセットボタンのセットアップ
 */
const setupResetButton = () => {
    const resetButton = document.getElementById('reset-display-button');
    resetButton.addEventListener('click', () => {
        // 1. 自動再生を停止し、UIをリセット
        pauseAutoplay(true); // skipRedraw = true

        // 2. 表示エリアをクリア
        document.getElementById('content-line-1').textContent = '';
        document.getElementById('content-line-2').textContent = '';
        document.getElementById('current-shindo-label').classList.add('hidden');

        // 3. ページインデックスをリセット
        CURRENT_SHINDO_INDEX = 0;
        updateNavControls({}, null); // ページ番号表示などをリセット
    });
};

/**
 * キーボードショートカットを設定する
 */
const setupKeyboardShortcuts = () => {
    // 保存されたループ再生の最低震度を読み込む
    const savedMinScale = localStorage.getItem('loopPlaybackMinScale');
    if (savedMinScale) {
        loopPlaybackMinScale = parseInt(savedMinScale, 10);
    }

    // 保存された設定を読み込む
    const savedShortcut = localStorage.getItem('autoplayShortcut');
    if (savedShortcut) {
        try {
            shortcutSetting = JSON.parse(savedShortcut);
        } catch (e) {
            console.error('ショートカット設定の読み込みに失敗:', e);
        }
    }

    // 保存されたEEW通知音設定を読み込む
    const savedEewSoundSetting = localStorage.getItem('playEewSound');
    if (savedEewSoundSetting !== null) {
        playEewSound = savedEewSoundSetting === 'true';
    } else {
        playEewSound = true; // 保存された設定がなければデフォルトで有効
    }

    window.addEventListener('keydown', (event) => {
        // テキスト入力中などはショートカットを無効にする
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'SELECT') {
            return;
        }

        // 設定されたショートカットと一致するかチェック
        const isCtrlMatch = shortcutSetting.ctrl === event.ctrlKey;
        const isAltMatch = shortcutSetting.alt === event.altKey;
        const isShiftMatch = shortcutSetting.shift === event.shiftKey;
        const isKeyMatch = shortcutSetting.key === event.code;

        if (isCtrlMatch && isAltMatch && isShiftMatch && isKeyMatch) {
            event.preventDefault(); // ページのスクロールを防ぐ
            const toggleButton = document.getElementById('autoplay-toggle');
            // ボタンが表示されている場合のみクリックをトリガー
            if (toggleButton && toggleButton.offsetParent !== null) {
                toggleButton.click();
            }
        }
    });
};

/**
 * ショートカット設定モーダルのセットアップ
 */
const setupShortcutModal = () => {
    const modal = document.getElementById('shortcut-modal');
    const openButton = document.getElementById('shortcut-settings-button');
    const closeButton = document.getElementById('shortcut-modal-close');
    const closeXButton = document.getElementById('shortcut-modal-close-x');
    const input = document.getElementById('shortcut-modal-input');
    const saveButton = document.getElementById('shortcut-modal-save');
    const minScaleSelect = document.getElementById('loop-min-shindo-select');
    const listMinScaleSelect = document.getElementById('list-min-shindo-select');
    const eewSoundToggle = document.getElementById('eew-sound-toggle');

    openButton.addEventListener('click', () => {
        modal.classList.remove('hidden');
        // 現在の設定値をUIに反映
        input.value = formatShortcutText(shortcutSetting);
        listMinScaleSelect.value = CONFIG.MIN_LIST_SCALE;
        eewSoundToggle.checked = playEewSound;
        minScaleSelect.value = loopPlaybackMinScale;
        input.focus();
    });

    const closeModal = () => modal.classList.add('hidden');
    closeButton.addEventListener('click', closeModal);
    closeXButton.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    input.addEventListener('keydown', (e) => {
        e.preventDefault();
        // 修飾キーのみの登録は許可しない
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

        shortcutSetting = {
            ctrl: e.ctrlKey,
            alt: e.altKey,
            shift: e.shiftKey,
            key: e.code
        };
        input.value = formatShortcutText(shortcutSetting);
    });

    saveButton.addEventListener('click', () => {
        // 設定を保存
        localStorage.setItem('autoplayShortcut', JSON.stringify(shortcutSetting));
        loopPlaybackMinScale = parseInt(minScaleSelect.value, 10);
        localStorage.setItem('loopPlaybackMinScale', loopPlaybackMinScale);
        CONFIG.MIN_LIST_SCALE = parseInt(listMinScaleSelect.value, 10);
        localStorage.setItem('listMinScale', CONFIG.MIN_LIST_SCALE);
        playEewSound = eewSoundToggle.checked;
        localStorage.setItem('playEewSound', playEewSound);

        // 現在選択されている地震の表示を新しい設定で更新する
        if (selectedCardId) {
            const eventId = selectedCardId.substring(5); // "card-"を削除
            const eqData = PROCESSED_EARTHQUAKES.find(eq => eq.id === eventId);
            if (eqData) {
                // 新しい設定で固定バーのビューを再生成
                updateFixedShindoBar(eqData);
            }
        }

        // 設定変更を即時反映するためにデータを再取得・描画
        refreshData();

        closeModal();
    });
};

/**
 * ショートカット設定オブジェクトを整形された文字列に変換
 */
const formatShortcutText = (setting) => {
    const parts = [];
    if (setting.ctrl) parts.push('Ctrl');
    if (setting.alt) parts.push('Alt');
    if (setting.shift) parts.push('Shift');
    
    let displayKey = setting.key;
    if (displayKey.startsWith('Key')) {
        displayKey = displayKey.substring(3); // 'KeyA' -> 'A'
    } else if (displayKey.startsWith('Digit')) {
        displayKey = displayKey.substring(5); // 'Digit1' -> '1'
    } else if (displayKey === 'Space') {
        displayKey = 'Space';
    } else if (displayKey.startsWith('Numpad')) {
        displayKey = `Numpad ${displayKey.substring(6)}`; // 'Numpad1' -> 'Numpad 1'
    }

    parts.push(displayKey);
    return parts.join(' + ');
};

/**
 * 自動ページ送り機能のセットアップ
 */
const setupAutoplayControls = () => {
    const toggleButton = document.getElementById('autoplay-toggle');
    const loopsSelect = document.getElementById('autoplay-loops');

    // ループ回数の選択肢を生成
    for (let i = 1; i <= 10; i++) {
        const option = document.createElement('option');
        option.value = i;
        option.textContent = i;
        loopsSelect.appendChild(option);
    }
    const infiniteOption = document.createElement('option');
    infiniteOption.value = 'Infinity';
    infiniteOption.textContent = '∞';
    loopsSelect.appendChild(infiniteOption);
    loopsSelect.value = '3'; // デフォルトを3回に変更

    toggleButton.addEventListener('click', () => {
        if (isAutoplaying) {
            pauseAutoplay(true); // 動作を「停止してリセット」に変更
        } else {
            startAutoplay();
        }
    });
};

const startAutoplay = async () => {
    if (isAutoplaying || FIXED_BAR_VIEWS.length <= 1) return;

    // APIの自動更新を一時停止
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
        console.log('ループ再生開始のため、API自動更新を一時停止します。');
    }

    const durationInput = document.getElementById('autoplay-duration');
    const loopsSelect = document.getElementById('autoplay-loops');
    const playIcon = document.getElementById('play-icon');
    const pauseIcon = document.getElementById('pause-icon');
    const toggleSwitch = document.getElementById('toggle-mode');
    const refreshButton = document.getElementById('refresh-button');
    const earthquakeList = document.getElementById('earthquake-list');
    const dummyDataButton = document.getElementById('toggle-dummy-data-button');
    const toggleLabel = toggleSwitch.closest('label');
    const duration = (parseInt(durationInput.value, 10) || 10) * 1000;
    const totalLoops = loopsSelect.value === 'Infinity' ? Infinity : parseInt(loopsSelect.value, 10);

    isAutoplaying = true;
    isWaitingForAutoplay = false; // 再生が開始されたので待機フラグを解除
    autoplayLoopCounter = 0;
    CURRENT_SHINDO_INDEX = 0; // 常に最初のページから開始
    // コントロールをロック
    toggleSwitch.disabled = true;
    refreshButton.disabled = true;
    toggleLabel.classList.add('opacity-50', 'cursor-not-allowed');
    // earthquakeList.classList.add('opacity-50', 'pointer-events-none'); // この行を削除
    refreshButton.classList.add('opacity-50', 'cursor-not-allowed');
    dummyDataButton.disabled = true;
    dummyDataButton.classList.add('opacity-50', 'cursor-not-allowed');

    // 選択されていないカードをグレーアウトし、クリックを無効化
    document.querySelectorAll('.earthquake-card').forEach(card => {
        if (card.id !== selectedCardId) {
            card.classList.add('grayed-out-card');
        }
    });

    // 地震一覧全体のクリックを無効化
    earthquakeList.classList.add('pointer-events-none');

    // ON AIRバッジを表示 (グレーアウト処理の後に実行)
    if (selectedCardId) {
        document.getElementById(`on-air-${selectedCardId.substring(5)}`)?.classList.remove('hidden');
    }

    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');

    // 1. 開始ページ「地震情報」を表示
    const startView = {
        type: 'system', shindo: '情報', line1: '地震情報', line2: '',
        shindoClass: 'bg-blue-600 text-white', pageCurrent: '▶', pageTotal: ''
    };
    updateFixedBarDisplay(startView);

    // 2. 最初の情報ページへの遷移を待つ
    // await new Promise(resolve => setTimeout(resolve, duration));
    // if (!isAutoplaying) return; // 待機中に停止された場合

    // 3. メインのページ送りを開始
    // インデックスを-1にリセットし、最初のインターバルで0になるようにする
    CURRENT_SHINDO_INDEX = -1; 
    autoplayIntervalId = setInterval(() => {
        if (!isAutoplaying) return;

        // ページを進める
        if (CURRENT_SHINDO_INDEX < FIXED_BAR_VIEWS.length - 1) {
            CURRENT_SHINDO_INDEX++;
        } else {
            // 最終ページに到達した場合、ループ処理
            autoplayLoopCounter++;
            if (totalLoops !== Infinity && autoplayLoopCounter >= totalLoops) {
                // ループ終了処理
                clearInterval(autoplayIntervalId);
                autoplayIntervalId = null;

                // 終了ページを表示
                const endView = {
                    type: 'system', shindo: '情報', line1: '地震情報　終', line2: '',
                    shindoClass: 'bg-blue-600 text-white', pageCurrent: '■', pageTotal: ''
                };
                updateFixedBarDisplay(endView);

                // 終了画面表示後、待機中のメッセージを表示
                document.getElementById('shindo-page-info').textContent = '地震 待機中';

                // 指定秒数後に表示をクリアする
                setTimeout(() => {
                    document.getElementById('content-line-1').textContent = '';
                    document.getElementById('current-shindo-label').classList.add('hidden');
                    pauseAutoplay(true); // 完全に停止状態に戻す
                }, duration);
                return;
            }
            // 次のループの開始に戻る
            CURRENT_SHINDO_INDEX = 0;
        }

        // ページを表示
        updateFixedBarDisplay(null, 'next');
    }, duration);
};

const pauseAutoplay = (skipRedraw = false) => {
    // isAutoplaying が false の場合でも、アイコンの状態をリセットするために処理を続ける場合がある
    // if (!isAutoplaying) return;

    const playIcon = document.getElementById('play-icon');
    const pauseIcon = document.getElementById('pause-icon');
    const toggleSwitch = document.getElementById('toggle-mode');
    const refreshButton = document.getElementById('refresh-button');
    const earthquakeList = document.getElementById('earthquake-list');
    const dummyDataButton = document.getElementById('toggle-dummy-data-button');
    const toggleLabel = toggleSwitch.closest('label');

    clearInterval(autoplayIntervalId);
    autoplayIntervalId = null;
    isAutoplaying = false;
    isWaitingForAutoplay = false; // 停止したので待機フラグを解除
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');

    // コントロールのロックを解除
    toggleSwitch.disabled = false;
    refreshButton.disabled = false;
    toggleLabel.classList.remove('opacity-50', 'cursor-not-allowed');
    earthquakeList.classList.remove('pointer-events-none'); // 地震一覧のクリックを再度有効化
    refreshButton.classList.remove('opacity-50', 'cursor-not-allowed');
    dummyDataButton.disabled = false;
    dummyDataButton.classList.remove('opacity-50', 'cursor-not-allowed');

    // 全てのカードのグレーアウトとクリック無効化を解除
    document.querySelectorAll('.earthquake-card').forEach(card => {
        card.classList.remove('grayed-out-card');
    });

    // 全てのON AIRバッジを非表示にする (グレーアウト解除の前に実行)
    document.querySelectorAll('.on-air-badge').forEach(badge => {
        badge.classList.add('hidden');
    });

    // アニメーションクラスが残っている場合があるので削除
    document.getElementById('animation-wrapper').className = 'flex items-center w-full h-full';

    // APIの自動更新を再開
    if (!refreshIntervalId && CONFIG.REFRESH_INTERVAL_MS > 0 && !isAutoplaying) {
        refreshIntervalId = setInterval(refreshData, CONFIG.REFRESH_INTERVAL_MS);
        console.log('ループ再生終了のため、API自動更新を再開します。');
    }

    if (skipRedraw) return;

    // 停止時に現在のインデックスの表示に戻す
    if (FIXED_BAR_VIEWS.length > 0) {
        updateFixedBarDisplay();
    } else {
        displayInitialFixedBarState();
    }
};

// --- 固定フッターのロジック 終了 ---


// --- トグルスイッチのロジック ---
const setupToggle = () => {
    const toggleSwitch = document.getElementById('toggle-mode');
    // IDはそのまま、テキストが市区町村別と観測点別になっている
    const labelPoint = document.getElementById('label-point'); // 右側（Checked側）
    const labelMunicipality = document.getElementById('label-municipality'); // 左側（Unchecked側）
    
    const updateDisplayMode = () => {
        const isChecked = toggleSwitch.checked;
        
        // ロジック:
        // isChecked (FALSE/左) = 市区町村別 ('municipality')
        // isChecked (TRUE/右) = 観測点別 ('point')
        DISPLAY_MODE = isChecked ? 'point' : 'municipality';

        // ラベルのスタイルを更新
        // ラベルのスタイルを更新 (ダークモード対応)
        if (isChecked) { 
            // TRUE: 観測点別(labelPoint)をアクティブにする
            labelPoint.classList.add('font-bold', 'text-blue-400');
            labelPoint.classList.remove('text-gray-400', 'font-medium');
            
            labelMunicipality.classList.remove('font-bold', 'text-blue-400');
            labelMunicipality.classList.remove('font-bold', 'text-blue-400', 'transition-colors', 'duration-200');
            labelMunicipality.classList.add('text-gray-400', 'font-medium');
        } else { 
            // FALSE: 市区町村別(labelMunicipality)をアクティブにする
            labelPoint.classList.remove('font-bold', 'text-blue-400');
            labelPoint.classList.add('text-gray-400', 'font-medium');
            
            labelMunicipality.classList.add('font-bold', 'text-blue-400');
            labelMunicipality.classList.remove('text-gray-400', 'font-medium');
            labelMunicipality.classList.remove('text-gray-400', 'font-medium', 'transition-colors', 'duration-200');
        }

        // 現在選択されている地震の詳細を再描画
        if (selectedCardId) {
            const eventId = selectedCardId.substring(5); // "card-"を削除
            const eqData = PROCESSED_EARTHQUAKES.find(eq => eq.id === eventId);
            if (eqData) {
                displayEarthquakeDetails(eqData);
            }
        }
    };

    toggleSwitch.addEventListener('change', updateDisplayMode);
    
    // 初期モードの適用 (デフォルトは市区町村別 'municipality')
    updateDisplayMode(); 
};

/**
 * 訓練モード切り替えボタンのセットアップ
 */
const setupDummyDataToggle = () => {
    const toggleButton = document.getElementById('toggle-dummy-data-button');
    const warningDiv = document.getElementById('dummy-data-warning');
    const body = document.body;

    toggleButton.addEventListener('click', () => {
        USE_DUMMY_DATA = !USE_DUMMY_DATA; // モードを反転

        if (USE_DUMMY_DATA) {
            toggleButton.textContent = '通常モードへ';
            toggleButton.classList.remove('bg-yellow-600', 'hover:bg-yellow-700');
            toggleButton.classList.add('bg-red-600', 'hover:bg-red-700');
            warningDiv.classList.remove('hidden');
            body.classList.add('pt-10'); // 警告バーの高さ分paddingを追加
        } else {
            toggleButton.textContent = '訓練モードへ';
            toggleButton.classList.remove('bg-red-600', 'hover:bg-red-700');
            toggleButton.classList.add('bg-yellow-600', 'hover:bg-yellow-700');
            warningDiv.classList.add('hidden');
            body.classList.remove('pt-10');
        }

        refreshData(); // モードを切り替えたらデータを再読み込み
    });
};

/**
 * ローカルストレージから手動ふりがな辞書を読み込む
 */
const loadManualKanaDict = () => {
    const savedDict = localStorage.getItem('manualKanaDictionary');
    if (savedDict) {
        try {
            MANUAL_KANA_DICT = JSON.parse(savedDict);
            console.log('手動ふりがな辞書を読み込みました。');
        } catch (e) {
            console.error('手動ふりがな辞書の読み込みに失敗しました:', e);
        }
    }
};

/**
 * EEW音声ファイルをプリロードする
 */
const preloadEewSound = () => {
    eewAudioObject = new Audio('https://github.com/AfterEffects-OK/EarthquakeEarlyWarning/raw/refs/heads/main/EEW_Woman_2.aac');
    eewAudioObject.preload = 'auto'; // ブラウザに音声のプリロードを指示
    eewAudioObject.load(); // 明示的にロードを開始
    console.log('EEW音声ファイルのプリロードを開始しました。');
};

/**
 * 放送用の原稿を生成し、新しいタブで表示する
 * @param {object} eq - 選択された地震情報オブジェクト
 */
const generateAndShowBroadcastScript = (eq) => {
    if (!FIXED_BAR_VIEWS || FIXED_BAR_VIEWS.length === 0) {
        alert("原稿を生成できませんでした。表示データがありません。");
        return;
    }

    // line1からふりがな付きのテキストを生成するヘルパー関数
    const createScriptTextWithRuby = (html) => {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        // 概況文（ふりがななし）
        if (!tempDiv.querySelector('.inline-block')) {
            return tempDiv.textContent.replace(/　/g, ' ') || "";
        }

        // 市区町村リスト（ふりがなあり）
        const cityElements = tempDiv.querySelectorAll('.inline-block.text-center');
        const citiesWithRuby = Array.from(cityElements).map(cityEl => {
            const kana = cityEl.querySelector('div').textContent.trim();
            const name = cityEl.querySelector('span').textContent.trim();
            return kana ? `<ruby>${name}<rt>${kana}</rt></ruby>` : name;
        });

        return citiesWithRuby.join(' ');
    };

    let lastShindo = '';
    const scriptLines = FIXED_BAR_VIEWS.map(view => {
        let line = '';
        if (view.shindo !== lastShindo) {
            line += `\n【${view.shindo}】\n`;
            lastShindo = view.shindo;
        }
        line += createScriptTextWithRuby(view.line1);
        return line;
    });

    // 震源地のふりがなを取得
    const epicenterKana = getKana(eq.epicenter) || '';
    const epicenterHtml = epicenterKana ? `<ruby>${eq.epicenter}<rt>${epicenterKana}</rt></ruby>` : eq.epicenter;

    const fullScript = scriptLines.join('\n').replace(/\n{3,}/g, '\n\n');

    // 新しいタブを開いて原稿を表示
    const newWindow = window.open('', '_blank');
    newWindow.document.write(`
        <!DOCTYPE html>
        <html lang="ja">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>放送原稿 - ${eq.epicenter} (${eq.time})</title>
            <style>
                @page { size: A4 landscape; }
                body { font-family: 'Meiryo', 'Hiragino Kaku Gothic ProN', sans-serif; line-height: 2.2; padding: 2rem; background-color: #f4f4f4; color: #333; }
                .container { max-width: 1122px; margin: 0 auto; background-color: #fff; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1 { font-size: 1.8rem; border-bottom: 2px solid #333; padding-bottom: 0.5rem; margin-bottom: 1.5rem; }
                pre { white-space: pre-wrap; word-wrap: break-word; font-size: 1.6rem; font-weight: bold; background-color: #fafafa; padding: 1.5rem; border-radius: 6px; border: 1px solid #ddd; }
                .info { margin-bottom: 1.5rem; font-size: 0.9rem; color: #666; }
                ruby { ruby-position: over; }
                rt { font-size: 0.7em; font-weight: normal; }
                @media print {
                    body { background-color: #fff; padding: 0; }
                    .container { box-shadow: none; border: none; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>放送原稿</h1>
                <div class="info">
                    <strong>地震:</strong> ${epicenterHtml}<br>
                    <strong>発生日時:</strong> ${eq.time}<br>
                    <strong>最大震度:</strong> ${eq.maxShindoLabel}
                </div>
                <pre>${fullScript.replace(new RegExp(eq.epicenter, 'g'), epicenterHtml)}</pre>
            </div>
        </body>
        </html>
    `);
    newWindow.document.close();
};

// --- 初期化 ---

window.onload = async () => {
    // ★★★ 最初に読み仮名辞書を生成する ★★★
    await buildKanaDictionary();
    preloadEewSound(); // EEW音声ファイルをプリロード

    // 保存された一覧フィルター設定を読み込む
    const savedListMinScale = localStorage.getItem('listMinScale');
    if (savedListMinScale) {
        CONFIG.MIN_LIST_SCALE = parseInt(savedListMinScale, 10);
    }

    // トグルスイッチの設定とイベントリスナーの設定
    setupToggle(); 
    
    // リフレッシュボタンのイベントリスナーを設定
    document.getElementById('refresh-button').addEventListener('click', refreshData);

    // 訓練モード切り替えボタンのセットアップ
    setupDummyDataToggle();
    
    // 固定バーのナビゲーションイベントを設定
    setupFixedBarNavigation();

    // リセットボタンのセットアップ
    setupResetButton();

    // トランジション設定コントロールを表示
    document.getElementById('transition-controls').style.display = 'flex';

    // 自動ページ送り機能のセットアップ
    setupAutoplayControls();
    
    // キーボードショートカットのセットアップ
    setupKeyboardShortcuts();

    // ショートカット設定モーダルのセットアップ
    setupShortcutModal();

    // ★★★ 追加: 手動ふりがな辞書をローカルストレージから読み込む ★★★
    loadManualKanaDict();

    // ★★★ 追加: ふりがな辞書管理モーダルのセットアップ ★★★
    setupKanaDbModal();

    // 初回表示: データを取得していない状態のメッセージを設定
    document.getElementById('fetch-time-display').textContent = '最終取得日時: データを取得していません';
    
    // 固定バーを初期状態に設定
    displayInitialFixedBarState();

    // 初回データ取得を refreshData() で実行
    await refreshData();

    // 定期的な自動更新を設定
    refreshIntervalId = setInterval(refreshData, CONFIG.REFRESH_INTERVAL_MS);
};
