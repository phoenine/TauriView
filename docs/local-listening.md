# 本地听书实现

本地语音使用 Faster-Qwen3-TTS 0.5.4 的 Torch / CUDA Graph 后端，Qwen3-TTS 12Hz 0.6B CustomVoice 权重，bfloat16、SDPA，24 kHz 单声道 PCM16。默认 Serena，可切换 Uncle_Fu。没有提供 0.6B 不支持的风格指令。

## 界面

- 阅读工具栏的听书按钮紧接搜索按钮，沿用原有尺寸与颜色。
- 划线工具栏在 AI 理解右侧增加「从这里听」，按选区所在句子定位，继续朗读本章后文。
- 纸色小播放器提供播放/暂停、上一段/下一段、当前片段进度、倍速、定位原文。更多菜单提供从当前段开始、准备本章、暂停/继续准备、朗读设置。
- 设置只保留音色、模型与下载状态、缓存清理。没有 Python 路径、模型目录或最近听过列表。

服务使用单段恒定增益做温和音量匹配，目标 RMS 0.06，最大增益 6 dB、峰值不超过 -1 dBFS。它保持语速和波形形状，不改变音色，也不提供基于测试文本名称的风格预设。音量处理版本计入音频缓存标识。

## 定位与队列

只提取文字 EPUB 的章节原始 DOM；过滤脚本、隐藏内容、导航和 ruby 注音，保留正文原始节点偏移与 CFI。按句号等自然边界切分，过长句子再拆分，保持重复文本的不同位置可区分。不按可见页提取，也不使用估算逐字时间对齐。

听书任务记录完整章节、固定书籍内容指纹和起点。指定新位置时，原播放停止，旧任务暂停；正在合成的一段完成后缓存，其后的排队内容让位给新起点。首段完成即可播放，后续继续生成；无缓存的片段需要等待，缓存命中立即读取。第一版到本章末尾结束，不会自动生成整本书。

任务、听书段落索引和段内时间保存在独立的 listening.json，翻页与返回书架不改变听书任务。只有用户主动点定位原文才跳转阅读器。

## 进程与默认位置

生产环境使用 Tauri 的应用数据目录下 `tts/`，包含 `runtime/`、`python/`、`models/`、`audio/`、`listening.json`；界面无需配置位置。开发环境缓存位于 `.local-tts/dev-tts`，可复用已经验证的 `.local-tts/fast-venv` 与模型。

缺少运行环境时，用户点击「下载并准备」，Windows 安装器在默认目录下载校验固定版本 uv，准备独立 Python 3.12.9、固定 CUDA wheels 和依赖，然后检查 CUDA。无需系统安装 Python、修改 PATH 或管理员权限。依赖快照在 resources/tts/requirements.txt，安装进度与日志在 setup-status.json / setup.log。关闭应用会终止其安装进程树；再次点击可重试。此安装器的脚本解析、参数与当前依赖已检查，尚未在无 Python 的干净 Windows 机器上完成完整安装验收。

模型通过 ModelScope 下载，manifest 固定 10 个文件的大小和 SHA256；临时文件支持 Range 续传，完整校验后才发布。网络探测已验证配置文件与模型 Range 响应。没有重复下载本机已有的 2.5 GB 权重。

Python 工作进程通过 JSON-lines 通信，日志使用 stderr，与协议分开。生产由 Rust 持有进程，通过 Tauri IPC 调用；开发由 Vite 的仅限本机、校验 Origin 的适配器转发，生产不额外监听 HTTP 端口。模型首次生成时加载，单线程合成，闲置 5 分钟释放模型。没有 CPU 静默回退。

音频按模型全部推理文件指纹、引擎版本、生成参数、处理版本、音色、语言、文本建立内容缓存，先校验 WAV 再原子发布；播放前校验音频校验和。缓存上限 2 GiB，回收未使用任务的旧片段，保留当前任务与排队任务。清理缓存需先暂停播放和生成；任务位置仍保留。

## 验证

- `python tests/listening.test.py`：队列优先级、定位、缓存复用、重启恢复、坏音频拒绝、下载续传/校验、音量增益与峰值约束。
- `node tests/listening-browser.cjs`：真实 EPUB 选区与 CFI、同文不同位置、等待与播放状态、独立阅读进度、控件与深浅色截图；生成队列用确定性响应，另检查真实 WAV 解码。
- `node tests/listening-bridge.cjs`：实际 Vite → Python 协议、默认路径、不加载 GPU 的状态查询、Origin 与非法操作拒绝。
- `python tests/listening-gpu.py`：实际 CUDA 短句、WAV、缓存命中、进程重启与位置恢复，不下载或替换模型。初次服务验证首段就绪约 16.83 秒，包含进程与模型加载，音频 4.08 秒；此数字不是预热后吞吐。
- `python tests/listening-download-probe.py`：主动网络探测，仅配置文件及模型前 16 字节。

上面的 Python 命令使用项目已经验证的 fast-venv。浏览器脚本需要 Playwright；AI 和词典测试使用 `tests/fixtures/sherlock.epub`，测试用书不随应用打包。语音的中文读音和长时间接缝仍需要实际听查，技术校验不替代主观音色评价。

来源：[Faster-Qwen3-TTS](https://github.com/andimarafioti/faster-qwen3-tts)、[Qwen 模型](https://modelscope.cn/models/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice)、[uv 0.12.13](https://github.com/astral-sh/uv/releases/tag/0.12.13)。
