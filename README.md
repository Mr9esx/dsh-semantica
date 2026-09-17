# dsh\-semantica\-graph 插件介绍

这是一款 DSH 专属插件，核心作用是**把你的 AI 对话内容自动生成可视化知识图谱**，依托开源工具 Semantica 实现完整图谱能力，支持原生图谱浏览器查看、对话决策链追溯、AI 智能分析图谱等功能。

## 一、项目底层依托

本插件**基于官方 Semantica 原生开发**（Python 知识图谱开源框架），并非自研复刻：

- 直接调用 Semantica 官方核心能力：实体识别、关系抽取、图谱构建、可视化浏览器（Knowledge Explorer）

- 完全复用官方全套能力：22 组命令工具、78 个 REST 接口、6 大可视化工作区

- 图谱界面 100% 为 Semantica 原版，插件不做自定义绘制，全程同步官方所有功能

插件仅做适配层工作：读取 DSH 对话数据、清洗过滤无效内容、搭建对话专属图谱、嵌入官方可视化界面。

## 二、插件专属新增能力（原生 Semantica 没有）

Semantica 本身无法适配 DSH 对话场景，本插件针对性做了全套优化和定制开发：

- **适配 DSH 会话数据**：解析 DSH 压缩格式的对话日志，还原完整对话轮次、消息、工具调用记录

- **智能过滤无效内容**：自动剔除系统通知、后台日志、模型思考过程、代码块、无效工具文本，避免图谱冗余失真，大幅提升建图速度和精准度

- **双语智能抽取**：自动识别对话中英文占比，中文调用专属模型、英文调用原生模型，解决中英文混聊抽取错乱问题

- **对话决策链可视化**：独家解析对话中的人工提问、选项选择、决策逻辑，生成可追溯的因果决策图谱

- **AI 图谱专项分析**：一键新开独立对话，自动注入图谱数据，支持复盘对话、解析图谱、校验抽取质量、生成任务建议，不占用当前对话上下文

- **本地化适配优化**：修复时区、字符兼容、页面渲染问题，适配 DSH 对话视图区

## 三、核心功能

- **对话一键成图**：任意对话点击 **知识图谱** 标签（或标题旁的图谱按钮），自动生成包含节点、实体、关系、工具调用的完整知识图谱，并可在浏览器中打开查看

- **可视化决策追溯**：在图谱浏览器中直观查看对话全程决策逻辑、备选方案、最终选择及因果关联

- **智能图谱分析**：四大一键分析功能，新开对话无压力解析图谱，支持深度追问

- **智能缓存更新**：图谱自动缓存，二次打开秒加载；对话更新后自动标记过期，支持一键重新抽取

- **图谱文件可及**：工具栏直接显示图谱 JSON 文件的落盘路径，点一下复制完整路径，可自行用编辑器打开或交给其他工具

- **全宽图谱视图**：面板即一个对话标签页，铺满整个对话区（不再是 640px 的侧边栏），图谱比原来宽一倍以上

## 四、安装教程（极简版）

### 前置依赖（必须配齐）

- 正常运行的 DSH（桌面端/命令行均可）

- Node\.js ≥22\.19\.0 或 ≥24\.0\.0

- Python ≥3\.8（推荐 3\.12\.7）

- **无需任何第三方插件**：图谱面板直接挂在对话自己的标签栏里（与「对话 / 轨迹 / 上下文」并排），不依赖 dsh\-better\-sidebar

### 步骤1：搭建独立 Python 环境 \& 安装依赖

务必使用独立虚拟环境，避免依赖版本冲突

```Plain Text
# 自动识别 DSH 路径，创建专属虚拟环境
DSH_HOME="${DSH_HOME:-$HOME/Library/Application Support/dsh-desktop/harness}"
[ -d "$DSH_HOME" ] || DSH_HOME="$HOME/.dsh"
python3 -m venv "$DSH_HOME/semantica-venv"

# 安装带可视化浏览器的完整 Semantica 版本
"$DSH_HOME/semantica-venv/bin/pip" install -U pip
"$DSH_HOME/semantica-venv/bin/pip" install "semantica[explorer]"

# 安装中英双语实体识别模型（缺一不可）
"$DSH_HOME/semantica-venv/bin/python" -m spacy download en_core_web_sm
"$DSH_HOME/semantica-venv/bin/python" -m spacy download zh_core_web_sm
```

### 步骤2：安装插件本体

```Plain Text
# 进入插件目录
cd /path/to/dsh-semantica-graph

# 安装基础依赖
npm install

# 自动注册插件到 DSH 环境
node scripts/install.mjs
```

### 步骤3：重启生效

**完全退出重启 DSH 桌面端**（仅刷新页面不生效，后台路由需重启注册）

### 步骤4：验证安装成功

```Plain Text
# 查看插件是否被 DSH 识别
dsh --profile web --dump-config | grep -A 1 semantica

# 校验 Semantica 服务就绪
curl -s http://127.0.0.1:56020/api-semantica/status
```

返回 `ready: true` 即代表安装完成，可正常使用。

## 五、基础用法

打开任意 AI 对话 → 点击顶部的**知识图谱**标签（在「对话 / 轨迹 / 上下文」旁边），或点会话标题右侧的**图谱按钮** → 切换到图谱工作台，等待几秒即可生成完整对话知识图谱。

支持重新抽取、在浏览器打开看图、AI 一键分析等所有功能。

## 六、卸载方式

```Plain Text
cd /path/to/dsh-semantica-graph
node scripts/install.mjs --remove

# 彻底清理环境（可选）
rm -rf "$DSH_HOME/semantica-venv"
rm -rf "$DSH_HOME/dsh-semantica-graph"
```

卸载后重启 DSH 即可，仅移除插件引用，不影响其他 DSH 功能。

> （注：部分内容可能由 AI 生成）
