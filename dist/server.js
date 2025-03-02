'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var os = require('os');
var fs = require('fs');
var path = require('path');
var WebSocket = require('ws');
var ethers = require('ethers');

class DotServer {
    constructor(httpServer) {
        this.hasChanges = false;
        this.peers = new Set();
        this.data = new Map();
        this.dataFile = path.join(os.homedir(), 'dot-data.json'); // 文件目录 ~/dot-data.json
        this.loadData();
        // 定期保存数据
        setInterval(() => {
            if (this.hasChanges) {
                this.saveData();
                this.hasChanges = false;
            }
        }, 60 * 1000);
        this.server = new WebSocket.Server({ server: httpServer });
        this.server.on('connection', (socket) => {
            console.log('dot: 新客户端已连接');
            this.peers.add(socket);
            socket.on('message', (message) => {
                try {
                    const msg = JSON.parse(message.toString());
                    this.handleMessage(msg, socket);
                }
                catch (err) {
                    console.error('dot: 处理消息时出错:', err);
                }
            });
            socket.on('close', () => {
                console.log('dot: 客户端断开连接');
                this.peers.delete(socket);
            });
            socket.on('error', (error) => {
                console.error('dot: WebSocket 错误:', error);
            });
        });
        process.on('SIGINT', () => {
            console.log('dot: 正在保存数据并关闭服务器...');
            if (this.hasChanges) {
                this.saveData();
            }
            process.exit(0);
        });
    }
    checkDotKey(key) {
        const parts = key.split('/');
        if (parts.length < 2)
            return false;
        const address = parts[0];
        return ethers.isAddress(address.toLowerCase());
    }
    handleMessage(msg, sender) {
        switch (msg.type) {
            case 'put':
                try {
                    if (msg.key && msg.value !== undefined && msg.sig && msg.timestamp) {
                        if (this.checkDotKey(msg.key)) {
                            const success = this.putData(msg.key, msg.value, msg.sig, msg.timestamp);
                            if (success) {
                                // 发送确认消息给发送者
                                sender.send(JSON.stringify({
                                    type: 'ack',
                                    key: msg.key,
                                }));
                                // 广播同步消息给所有客户端
                                this.broadcast({
                                    type: 'sync',
                                    key: msg.key,
                                    value: msg.value,
                                    sig: msg.sig,
                                    timestamp: msg.timestamp,
                                }, null);
                            }
                            else {
                                sender.send(JSON.stringify({
                                    type: 'error',
                                    message: '签名验证失败',
                                }));
                            }
                        }
                        else {
                            sender.send(JSON.stringify({
                                type: 'error',
                                message: '无效的用户数据格式',
                            }));
                        }
                    }
                }
                catch (err) {
                    console.error('dot: put 操作出错:', err);
                    sender.send(JSON.stringify({
                        type: 'error',
                        message: '数据保存失败',
                    }));
                }
                break;
            case 'get':
                try {
                    if (msg.key) {
                        const data = this.data.get(msg.key);
                        sender.send(JSON.stringify({
                            type: 'get_response',
                            key: msg.key,
                            value: (data === null || data === void 0 ? void 0 : data.value) || null,
                            timestamp: (data === null || data === void 0 ? void 0 : data.timestamp) || null,
                        }));
                    }
                }
                catch (err) {
                    console.error('dot: get 操作出错:', err);
                    sender.send(JSON.stringify({
                        type: 'error',
                        message: '获取数据失败',
                    }));
                }
                break;
            case 'sync':
                try {
                    if (msg.key && msg.value !== undefined && msg.sig && msg.timestamp) {
                        const currentData = this.data.get(msg.key);
                        if (!currentData || currentData.timestamp < msg.timestamp) {
                            const success = this.putData(msg.key, msg.value, msg.sig, msg.timestamp);
                            if (success) {
                                this.broadcast(msg, sender);
                            }
                        }
                    }
                }
                catch (err) {
                    console.error('dot: sync 操作出错:', err);
                }
                break;
        }
    }
    putData(key, value, sig, timestamp) {
        try {
            // 获取地址(key的第一部分)
            const address = key.split('/')[0];
            // 重建完整的消息对象
            const messageObject = {
                key,
                value,
                timestamp,
            };
            // 将完整消息对象转换为 JSON 字符串
            const message = JSON.stringify(messageObject);
            // 验证签名
            const recoveredAddress = ethers.verifyMessage(message, sig);
            // 检查恢复的地址是否匹配 key 中的地址
            if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
                console.error('dot: 签名验证失败 - 地址不匹配');
                return false;
            }
            // 验证时间戳
            const currentTime = Date.now();
            if (Math.abs(currentTime - timestamp) > 5 * 60 * 1000) {
                // 5分钟有效期
                console.error('dot: 签名验证失败 - 时间戳过期');
                return false;
            }
            // 存储数据
            const entry = {
                value,
                sig,
                timestamp,
            };
            this.data.set(key, entry);
            this.hasChanges = true;
            // this.saveData()
            return true;
        }
        catch (err) {
            console.error('dot: 签名验证失败:', err);
            return false;
        }
    }
    saveData() {
        try {
            const data = {};
            for (const [key, entry] of this.data.entries()) {
                data[key] = entry;
            }
            fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
            console.log('dot: 用户数据已保存到文件');
        }
        catch (err) {
            console.error('dot: 保存数据出错:', err);
            this.hasChanges = true;
        }
    }
    loadData() {
        try {
            if (fs.existsSync(this.dataFile)) {
                const fileData = fs.readFileSync(this.dataFile, 'utf8');
                const data = JSON.parse(fileData);
                for (const [key, entry] of Object.entries(data)) {
                    if (this.checkDotKey(key)) {
                        this.data.set(key, entry);
                    }
                }
                console.log('dot: 已从文件加载用户数据');
            }
        }
        catch (err) {
            console.error('dot: 加载数据出错:', err);
        }
    }
    broadcast(message, exclude) {
        const msg = JSON.stringify(message);
        this.peers.forEach((peer) => {
            if ((!exclude || peer !== exclude) && peer.readyState === WebSocket.OPEN) {
                try {
                    peer.send(msg);
                }
                catch (err) {
                    console.error('dot: 广播消息出错:', err);
                }
            }
        });
    }
}

exports.DotServer = DotServer;
exports.default = DotServer;
