const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  server: "wss://hack.chat/chat-ws",
  channel: "lounge",
  botName: "sunldigv3_bot",
  commands: {
    help: "!help",
    roll: "!roll",
    stats: "!stats",
    save: "!save",
    afk: "!afk",
    specialHelp: "!help s",
    silence: "!s",
    unsilence: "!t",
    customCon: "!con",
    mute: "!mute",
    checkin: "!checkin",
    upper: "!upper",
    lower: "!lower",
    reply: "!reply",
    userinfo: "!userinfo",
    msglist: "!msglist"
  },
  commandDescriptions: {
    help: "显示所有可用命令及其说明",
    roll: "掷一个1-6的随机骰子",
    stats: "显示当前频道用户活跃度统计",
    save: "将聊天记录导出为JSON文件",
    afk: "设置/取消离开状态(AFK)",
    specialHelp: "显示特殊命令(需要权限)帮助",
    silence: "永久禁言指定用户",
    unsilence: "解除用户永久禁言",
    customCon: "发送自定义内容",
    mute: "临时禁言用户[格式：!mute 用户名 分钟数]",
    checkin: "每日签到，统计连续签到天数",
    upper: "文本转大写[格式：!upper 需要转换的文本]",
    lower: "文本转小写[格式：!lower 需要转换的文本]",
    reply: "引用历史消息回复（用!msglist查ID）",
    userinfo: "查询用户信息（默认查自己）",
    msglist: "显示最新5条消息ID及内容"
  },
  debug: true
};

const bot = {
  ws: null,
  afkUsers: new Map(),
  silencedUsers: new Map(), // 存储禁言过期时间戳（永久禁言存Infinity）
  messageHistory: [],
  userActivity: new Map(),
  checkinRecords: new Map(),  // 签到记录：key=用户名，value={lastDate: 上次签到日期, continuous: 连续天数}
  messageIdMap: new Map(),    // 消息ID映射：key=自增ID，value=消息对象
  nextMessageId: 1,           // 消息自增ID计数器
  scheduledIntervals: [],     // 定时器存储（用于临时禁言检查）

  init() {
    this.connect();
    this.startMuteCheckTimer(); // 启动临时禁言过期检查
    console.log(`[${CONFIG.botName}] 初始化完成`);
  },

  connect() {
    this.ws = new WebSocket(CONFIG.server);
    
    this.ws.on('open', () => {
      console.log(`[${CONFIG.botName}] WebSocket连接成功`);
      this.joinChannel();
    });
    
    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (CONFIG.debug) console.log('收到消息:', msg);
        this.recordMessage(msg); // 记录消息（已扩展ID功能）
        
        if (msg.cmd === 'chat') {
          const text = msg.text.trim();
          // 检查是否被禁言（判断过期时间）
          if (this.isSilenced(msg.nick)) {
            const remain = Math.ceil((this.silencedUsers.get(msg.nick) - Date.now()) / 60000);
            this.sendChat(`你已被禁言，剩余${remain > 0 ? remain : 0}分钟`, msg.nick);
            return; // 禁言用户无法发送消息
          }
          this.handleCommands(msg, text);
          this.handleAFK(msg);
        }
      } catch (e) {
        console.error('消息解析错误:', e);
      }
    });

    this.ws.on('close', () => {
      console.log('连接已关闭，5秒后尝试重连...');
      setTimeout(() => this.connect(), 5000); // 断线重连
    });

    this.ws.on('error', (err) => {
      console.error('WebSocket错误:', err);
    });
  },

  // 记录消息（扩展：添加消息ID，限制历史长度）
  recordMessage(msg) {
    if (msg.cmd === 'chat') {
      const msgWithId = {
        id: this.nextMessageId++,
        nick: msg.nick,
        text: msg.text,
        time: new Date().toISOString()
      };
      this.messageHistory.push(msgWithId);
      this.messageIdMap.set(msgWithId.id, msgWithId);

      // 限制历史记录长度（避免内存溢出）
      if (this.messageHistory.length > 1000) {
        const deletedMsg = this.messageHistory.shift();
        this.messageIdMap.delete(deletedMsg.id);
      }

      const count = this.userActivity.get(msg.nick) || 0;
      this.userActivity.set(msg.nick, count + 1);
    }
  },

  handleCommands(msg, text) {
    switch (text) {
      case CONFIG.commands.help:
        this.sendHelp(msg.nick);
        break;
      
      case "?":
        this.sendChat("我也很不解。", msg.nick);
        break;
      
      case CONFIG.commands.roll:
        this.sendChat(`🎲 随机骰子结果: ${Math.floor(Math.random() * 6) + 1}`, msg.nick);
        break;
      
      case CONFIG.commands.stats:
        this.sendUserStats(msg.nick);
        break;
      
      case CONFIG.commands.save:
        this.saveChatHistory(msg.nick); // 传入发送者昵称用于反馈
        break;
      
      case CONFIG.commands.afk:
        this.toggleAFK(msg.nick);
        break;
      
      case CONFIG.commands.specialHelp:
        this.sendSpecialHelp(msg.nick);
        break;

      case CONFIG.commands.checkin:
        this.handleCheckin(msg.nick);
        break;

      case CONFIG.commands.msglist:
        this.sendMsgList(msg.nick);
        break;
    }

    if (text.startsWith(CONFIG.commands.silence + ' ')) {
      this.handleSilence(msg, text);
    } else if (text.startsWith(CONFIG.commands.unsilence + ' ')) {
      this.handleUnsilence(msg, text);
    } else if (text.startsWith(CONFIG.commands.customCon + ' ')) {
      this.handleCustomCon(msg, text);
    } else if (text.startsWith(CONFIG.commands.mute + ' ')) {
      this.handleTempMute(msg, text);
    } else if (text.startsWith(CONFIG.commands.upper + ' ')) {
      const content = text.slice(CONFIG.commands.upper.length + 1);
      this.handleTextConvert(msg.nick, content, 'upper');
    } else if (text.startsWith(CONFIG.commands.lower + ' ')) {
      const content = text.slice(CONFIG.commands.lower.length + 1);
      this.handleTextConvert(msg.nick, content, 'lower');
    } else if (text.startsWith(CONFIG.commands.reply + ' ')) {
      this.handleReply(msg, text);
    } else if (text.startsWith(CONFIG.commands.userinfo + ' ')) {
      const target = text.slice(CONFIG.commands.userinfo.length + 1) || msg.nick;
      this.handleUserInfo(msg.nick, target);
    }
  },

  sendHelp(nick) {
    const commandsList = Object.entries(CONFIG.commands)
      .filter(([key]) => !['silence', 'unsilence', 'customCon', 'mute'].includes(key))
      .map(([cmd, trigger]) => `${trigger} - ${CONFIG.commandDescriptions[cmd]}`)
      .join('\n');
    
    const helpText = [
      "    bot命令帮助:",
      commandsList,
      "p.s. :不要滥用bot"
    ].join('\n');
    
    this.sendChat(helpText, nick);
  },

  sendSpecialHelp(nick) {
    const specialCommands = [
      `${CONFIG.commands.silence} [name] - ${CONFIG.commandDescriptions.silence}`,
      `${CONFIG.commands.unsilence} [name] - ${CONFIG.commandDescriptions.unsilence}`,
      `${CONFIG.commands.customCon} [text] - ${CONFIG.commandDescriptions.customCon}`,
      `${CONFIG.commands.mute} [name] [minutes] - ${CONFIG.commandDescriptions.mute}`
    ].join('\n');
    
    this.sendChat(`    特殊命令帮助（需要权限）:\n${specialCommands}`, nick);
  },

  handleSilence(msg, text) {
    const parts = text.split(' ');
    if (parts.length < 2) return;
    
    const targetUser = parts[1];
    const hasAuth = msg.nick.startsWith('sun');
    if (targetUser === CONFIG.botName) {
      this.sendChat("不能禁言bot自己", msg.nick);
      return;
    }
    
    if (hasAuth) {
      this.silencedUsers.set(targetUser, Infinity); // 永久禁言
      this.sendChat(`${targetUser} 已被永久禁言`, null);
    } else {
      this.sendChat("你无权执行此命令", msg.nick);
    }
  },

  handleUnsilence(msg, text) {
    const parts = text.split(' ');
    if (parts.length < 2) return;
    
    const targetUser = parts[1];
    const hasAuth = msg.nick.startsWith('sun');
    
    if (hasAuth) {
      this.silencedUsers.delete(targetUser);
      this.sendChat(`${targetUser} 的禁言已解除`, null);
    } else {
      this.sendChat("你无权执行此命令", msg.nick);
    }
  },

  handleCustomCon(msg, text) {
    const content = text.substring(CONFIG.commands.customCon.length + 1);
    const hasAuth = msg.nick.startsWith('sun');
    
    if (hasAuth) {
      this.sendChat(content, null);
    } else {
      this.sendChat("你无权执行此命令", msg.nick);
    }
  },

  toggleAFK(nick) {
    if (this.afkUsers.has(nick)) {
      const afkTime = Math.floor((Date.now() - this.afkUsers.get(nick)) / 1000);
      this.afkUsers.delete(nick);
      this.sendChat(`${nick} 已从AFK状态返回 (离开时长: ${afkTime}秒)`, null);
    } else {
      this.afkUsers.set(nick, Date.now());
      this.sendChat(`${nick} 已设置为AFK状态`, null);
    }
  },

  sendUserStats(nick) {
    const topUsers = [...this.userActivity.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([user, count]) => `${user}: ${count}条`)
      .join(', ');
    
    this.sendChat(`🏆 最活跃用户: ${topUsers || '暂无数据'}`, nick);
  },

  // Node.js版本：将聊天记录保存到本地文件（替换浏览器的Blob和a标签下载）
  saveChatHistory(nick) {
    const filename = `chat_history_${new Date().toISOString().slice(0,10)}.json`;
    const filepath = path.join(__dirname, filename);
    
    try {
      fs.writeFileSync(filepath, JSON.stringify(this.messageHistory, null, 2), 'utf8');
      this.sendChat(`聊天记录已保存到服务器: ${filename}`, nick);
      console.log(`聊天记录已保存至 ${filepath}`);
    } catch (err) {
      this.sendChat("保存聊天记录失败", nick);
      console.error("保存聊天记录错误:", err);
    }
  },

  handleAFK(msg) {
    const isMentioned = /@(\w+)/.test(msg.text);
    if (isMentioned) {
      const mentionedUser = msg.text.match(/@(\w+)/)[1];
      if (this.afkUsers.has(mentionedUser)) {
        const afkTime = Math.floor((Date.now() - this.afkUsers.get(mentionedUser)) / 1000);
        this.sendChat(`${mentionedUser} 正在AFK (已${afkTime}秒)`, null);
      }
    }
  },

  joinChannel() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        cmd: "join",
        channel: CONFIG.channel,
        nick: CONFIG.botName
      }));
    }
  },

  sendChat(text, mention) {
    const message = mention ? `@${mention} ${text}` : text;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ cmd: "chat", text: message }));
    } else {
      console.warn("WebSocket未连接，无法发送消息");
    }
  },

  // 新增：临时禁言处理
  handleTempMute(msg, text) {
    const parts = text.split(' ');
    if (parts.length < 3) {
      this.sendChat("格式错误：!mute 用户名 分钟数", msg.nick);
      return;
    }
    
    const targetUser = parts[1];
    const minutes = parseInt(parts[2]);
    const hasAuth = msg.nick.startsWith('sun');
    
    if (!hasAuth) {
      this.sendChat("你无权执行此命令", msg.nick);
      return;
    }
    
    if (isNaN(minutes) || minutes <= 0) {
      this.sendChat("请输入有效的分钟数", msg.nick);
      return;
    }
    
    const expireTime = Date.now() + (minutes * 60 * 1000);
    this.silencedUsers.set(targetUser, expireTime);
    this.sendChat(`${targetUser} 已被临时禁言 ${minutes} 分钟`, null);
  },

  // 新增：禁言状态检查
  isSilenced(nick) {
    const expireTime = this.silencedUsers.get(nick);
    if (!expireTime) return false;
    // 永久禁言（Infinity）或未过期的临时禁言
    return expireTime === Infinity || expireTime > Date.now();
  },

  // 新增：启动临时禁言检查定时器
  startMuteCheckTimer() {
    // 每分钟检查一次过期禁言
    const interval = setInterval(() => {
      const now = Date.now();
      for (const [user, expireTime] of this.silencedUsers.entries()) {
        if (expireTime !== Infinity && expireTime < now) {
          this.silencedUsers.delete(user);
          this.sendChat(`${user} 的临时禁言已过期`, null);
        }
      }
    }, 60 * 1000);
    
    this.scheduledIntervals.push(interval);
  },

  // 新增：签到功能
  handleCheckin(nick) {
    const today = new Date().toISOString().split('T')[0];
    const record = this.checkinRecords.get(nick) || { lastDate: null, continuous: 0 };
    
    if (record.lastDate === today) {
      this.sendChat(`${nick} 今天已经签过到啦！`, nick);
      return;
    }
    
    // 计算连续签到天数
    let continuous = 1;
    if (record.lastDate) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      if (record.lastDate === yesterday) {
        continuous = record.continuous + 1;
      }
    }
    
    this.checkinRecords.set(nick, { lastDate: today, continuous });
    this.sendChat(`${nick} 签到成功！当前连续签到 ${continuous} 天`, null);
  },

  // 新增：消息列表功能
  sendMsgList(nick) {
    const recentMsgs = this.messageHistory.slice(-5); // 取最新5条
    if (recentMsgs.length === 0) {
      this.sendChat("暂无消息记录", nick);
      return;
    }
    
    const msgList = recentMsgs.map(msg => `[${msg.id}] ${msg.nick}: ${msg.text}`).join('\n');
    this.sendChat(`最新5条消息:\n${msgList}`, nick);
  },

  // 新增：文本转换功能
  handleTextConvert(nick, content, type) {
    if (!content) {
      this.sendChat(`请输入需要转换的文本，格式：!${type} 文本内容`, nick);
      return;
    }
    
    const result = type === 'upper' ? content.toUpperCase() : content.toLowerCase();
    this.sendChat(result, nick);
  },

  // 新增：引用回复功能
  handleReply(msg, text) {
    const parts = text.split(' ', 2);
    if (parts.length < 2) {
      this.sendChat("格式错误：!reply 消息ID 回复内容", msg.nick);
      return;
    }
    
    const msgId = parseInt(parts[1]);
    const targetMsg = this.messageIdMap.get(msgId);
    
    if (!targetMsg) {
      this.sendChat("未找到该消息ID", msg.nick);
      return;
    }
    
    const replyContent = text.slice(parts[0].length + parts[1].length + 2);
    this.sendChat(`回复 @${targetMsg.nick} (ID:${msgId}): ${replyContent}`, null);
  },

  // 新增：用户信息查询
  handleUserInfo(nick, target) {
    const activity = this.userActivity.get(target) || 0;
    const isAfk = this.afkUsers.has(target);
    const isSilenced = this.isSilenced(target);
    
    let info = `${target} 的信息：\n`;
    info += `发送消息数：${activity}\n`;
    info += `AFK状态：${isAfk ? '是' : '否'}\n`;
    info += `禁言状态：${isSilenced ? '是' : '否'}`;
    
    this.sendChat(info, nick);
  }
};

// 启动机器人
bot.init();

// 处理进程退出
process.on('SIGINT', () => {
  console.log('正在关闭机器人...');
  bot.scheduledIntervals.forEach(interval => clearInterval(interval));
  if (bot.ws) bot.ws.close();
  process.exit();
});