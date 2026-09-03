// 测试插件配置和 URL 拼接
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testInput = {
    command: 'generate',
    prompt: '测试图片生成'
};

console.log('========== 开始测试 NanoBananaGen2 插件 ==========\n');
console.log('发送测试输入:', JSON.stringify(testInput, null, 2), '\n');

const pluginPath = path.join(__dirname, 'NanoBananaGen.mjs');
const child = spawn('node', [pluginPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
});

// 发送测试数据
child.stdin.write(JSON.stringify(testInput));
child.stdin.end();

let stdout = '';
let stderr = '';

child.stdout.on('data', (data) => {
    stdout += data.toString();
});

child.stderr.on('data', (data) => {
    stderr += data.toString();
    // 实时输出日志
    console.log('📋 日志:', data.toString());
});

child.on('close', (code) => {
    console.log('\n========== 测试结束 ==========');
    console.log('退出码:', code);
    
    if (stdout) {
        console.log('\n📤 标准输出:');
        console.log(stdout);
    }
    
    if (code !== 0) {
        console.log('\n❌ 插件执行失败');
    }
});

// 超时处理
setTimeout(() => {
    console.log('\n⏱️  测试超时 (60秒)，可能是在等待 API 响应...');
    child.kill();
}, 60000);
