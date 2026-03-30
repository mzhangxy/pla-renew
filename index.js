// index.js - PellaFree 自动续期脚本 (Node.js / GitHub Actions 专供版)

async function main(env) {
  console.log('开始执行 PellaFree 自动续期...');
  
  const accounts = parseAccounts(env.ACCOUNT);
  if (accounts.length === 0) {
    console.log('未找到有效账号，请检查 GitHub Secrets 配置');
    return;
  }
  
  const results = [];
  
  for (const account of accounts) {
    console.log(`\n=============================`);
    console.log(`处理账号: ${account.email}`);
    try {
      const result = await processAccount(account);
      results.push(result);
    } catch (error) {
      console.error(`账号 ${account.email} 处理失败:`, error.message);
      results.push({
        email: account.email,
        error: error.message,
        servers: [],
        renewResults: []
      });
    }
    await delay(2000);
  }
  
  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
    await sendTelegramNotification(env, results);
  }
  
  console.log('\n所有续期任务执行完毕！');
}

function parseAccounts(accountStr) {
  if (!accountStr) return [];
  
  return accountStr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && line.includes('-----'))
    .map(line => {
      const [email, password] = line.split('-----').map(s => s.trim());
      return { email, password };
    })
    .filter(acc => acc.email && acc.password);
}

async function processAccount(account) {
  const authData = await login(account.email, account.password);
  
  if (!authData.token) {
    throw new Error('登录失败，无法获取 token');
  }
  
  console.log(`账号 ${account.email} 登录成功`);
  
  let servers = await getServers(authData.token);
  console.log(`初始获取到 ${servers.length} 个服务器`);
  
  // 记录续期前的状态
  const beforeState = {};
  for (const server of servers) {
    const renewLinks = server.renew_links || [];
    beforeState[server.id] = {
      expiry: server.expiry,
      ip: server.ip,
      totalLinks: renewLinks.length,
      unclaimedLinks: renewLinks.filter(l => l.claimed === false).length
    };
  }
  
  const renewResults = [];
  
  // 核心逻辑：遍历服务器，触发广告，获取详情，执行续期
  for (const server of servers) {
    console.log(`\n处理服务器 ${server.id} (IP: ${server.ip || 'N/A'})`);
    
    // 第一步: 调用 renew/update 强制刷新广告链接
    console.log(`调用 renew/update 刷新广告链接...`);
    try {
      const updateResp = await fetch(`https://api.pella.app/server/renew/update?id=${server.id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authData.token}`,
          'Content-Type': 'application/json',
          'Origin': 'https://www.pella.app',
          'Referer': 'https://www.pella.app/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        body: '{}'
      });
      const updateText = await updateResp.text();
      console.log(`renew/update 响应: ${updateResp.status} ${updateText}`);
    } catch (e) {
      console.error(`renew/update 请求失败:`, e.message);
    }

    await delay(1000);
    
    // 第二步: 获取刷新后的服务器详情提取续期链接
    let renewLinks = [];
    try {
      const detailResp = await fetch(`https://api.pella.app/server/detailed?id=${server.id}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authData.token}`,
          'Content-Type': 'application/json',
          'Origin': 'https://www.pella.app',
          'Referer': 'https://www.pella.app/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      const detailData = await detailResp.json();
      renewLinks = detailData.renew_links || [];
      console.log(`获取到 ${renewLinks.length} 个续期链接`);
    } catch (e) {
      console.error(`获取详情失败:`, e.message);
      renewLinks = server.renew_links || [];
    }

    // 第三步: 执行续期
    if (renewLinks.length === 0) {
      renewResults.push({
        serverId: server.id,
        skipped: true,
        message: '无可用链接'
      });
    } else {
      const unclaimedLinks = renewLinks.filter(l => l.claimed === false);
      const linksToTry = unclaimedLinks.length > 0 ? unclaimedLinks : renewLinks;
      
      console.log(`总链接数: ${renewLinks.length}, 将尝试: ${linksToTry.length}`);
      
      let hasSuccess = false;
      for (let i = 0; i < linksToTry.length; i++) {
        const linkObj = linksToTry[i];
        const linkUrl = typeof linkObj === 'string' ? linkObj : (linkObj.link || linkObj);
        
        console.log(`处理续期链接 ${i + 1}/${linksToTry.length}: ${linkUrl}`);
        
        try {
          const result = await renewServer(authData.token, server.id, linkUrl);
          console.log(`续期结果: ${result.message}`);
          
          if (result.success) {
            renewResults.push({
              serverId: server.id,
              success: true,
              message: '续期成功'
            });
            hasSuccess = true;
            break; // 成功一次即可退出当前服务器的链接遍历
          } else if (!result.alreadyClaimed) {
             renewResults.push({
              serverId: server.id,
              success: false,
              message: result.message
            });
          }
        } catch (error) {
          console.error(`续期失败:`, error.message);
          renewResults.push({
            serverId: server.id,
            success: false,
            message: error.message
          });
        }
        await delay(1000);
      }
      
      if (!hasSuccess && unclaimedLinks.length === 0) {
         renewResults.push({
            serverId: server.id,
            skipped: true,
            message: '广告均已领取/冷却中'
         });
      }
    }
    
    // 无条件强制重启
    console.log(`服务器 ${server.id} 正在发送重启请求...`);
    try {
      await delay(2000);  
      const redeployResult = await redeployServer(authData.token, server.id);
      renewResults.push({
        serverId: server.id,
        isRedeploy: true, 
        success: redeployResult.success,
        message: redeployResult.message
      });
      console.log(`重启结果: ${redeployResult.success ? '成功' : '失败'} - ${redeployResult.message}`);
    } catch (error) {
      console.error(`重启失败:`, error.message);
      renewResults.push({
        serverId: server.id,
        isRedeploy: true,
        success: false,
        message: error.message
      });
    }
  }
  
  await delay(2000);
  try {
     servers = await getServers(authData.token);
  } catch(e) {}
  
  return {
    email: account.email,
    servers: servers.map(s => {
      const before = beforeState[s.id] || {};
      const rLinks = s.renew_links || [];
      return {
        id: s.id,
        ip: s.ip || before.ip,
        status: s.status,
        expiry: s.expiry,
        beforeExpiry: before.expiry,
        beforeUnclaimedLinks: before.unclaimedLinks || 0,
        totalLinks: rLinks.length,
        currentUnclaimedLinks: rLinks.filter(l => l.claimed === false).length
      };
    }),
    renewResults
  };
}

// 采用更健壮的 Clerk 登录逻辑并处理 Cookie
async function login(email, password) {
  const CLERK_API_VERSION = '2025-11-10';
  const CLERK_JS_VERSION = '5.125.3';
  
  const signInResponse = await fetch(`https://clerk.pella.app/v1/client/sign_ins?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://www.pella.app',
      'Referer': 'https://www.pella.app/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: new URLSearchParams({ locale: 'zh-CN', identifier: email, password, strategy: 'password' }).toString()
  });
  
  if (!signInResponse.ok) {
    const errorText = await signInResponse.text().catch(() => '');
    throw new Error(`登录失败: HTTP ${signInResponse.status} ${errorText}`);
  }
  
  const signInData = await signInResponse.json();
  let sessionId = signInData.response?.created_session_id;
  let token = null;
  
  if (signInData.client?.sessions?.length > 0) {
    const session = signInData.client.sessions[0];
    sessionId = sessionId || session.id;
    token = session.last_active_token?.jwt;
  }
  
  // Node.js 中提取 headers 的方式
  const cookieHeader = signInResponse.headers.get('set-cookie');
  const cookies = Array.isArray(cookieHeader) ? cookieHeader.join(';') : (cookieHeader || '');
  const clientCookie = extractCookie(cookies, '__client');
  
  if (token) return { token, sessionId, clientCookie };
  
  if (sessionId) {
    const touchResponse = await fetch(`https://clerk.pella.app/v1/client/sessions/${sessionId}/touch?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://www.pella.app',
        'Referer': 'https://www.pella.app/',
        'Cookie': clientCookie ? `__client=${clientCookie}` : '',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: 'active_organization_id='
    });
    
    if (touchResponse.ok) {
      const touchData = await touchResponse.json();
      token = touchData.sessions?.[0]?.last_active_token?.jwt || touchData.last_active_token?.jwt;
    }
  }
  
  if (!token && sessionId) {
    const tokensResponse = await fetch(`https://clerk.pella.app/v1/client/sessions/${sessionId}/tokens?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://www.pella.app',
        'Referer': 'https://www.pella.app/',
        'Cookie': clientCookie ? `__client=${clientCookie}` : '',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: ''
    });
    
    if (tokensResponse.ok) {
      const tokensData = await tokensResponse.json();
      token = tokensData.jwt;
    }
  }
  
  if (!token) throw new Error('登录成功但无法获取 token');
  return { token, sessionId, clientCookie };
}

async function getServers(token) {
  const ts = new Date().getTime();
  const response = await fetch(`https://api.pella.app/user/servers?_t=${ts}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Origin': 'https://www.pella.app',
      'Referer': 'https://www.pella.app/',
      'Cache-Control': 'no-cache', 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  
  if (!response.ok) {
    throw new Error(`获取服务器列表失败: ${response.status}`);
  }
  
  const data = await response.json();
  return data.servers || [];
}

async function renewServer(token, serverId, renewLink) {
  const linkId = renewLink.split('/renew/')[1];
  if (!linkId) return { success: false, alreadyClaimed: false, message: '无效链接' };
  
  const response = await fetch(`https://api.pella.app/server/renew?id=${linkId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Origin': 'https://www.pella.app',
      // 【关键修复点】：请求头 Referer 必须携带精准的 linkId 进行模拟来源验证
      'Referer': `https://pella.app/renew/${linkId}`, 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: '{}'
  });
  
  const responseText = await response.text();
  console.log(`续期API响应: ${response.status} ${responseText}`);
  
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    return { success: false, alreadyClaimed: false, message: `解析失败` };
  }

  if (data.success) return { success: true, alreadyClaimed: false, message: '续期成功' };
  if (data.error === 'Already claimed' || (data.message && data.message.includes('Already claimed'))) {
    return { success: false, alreadyClaimed: true, message: 'Already claimed' };
  }
  if (data.error) return { success: false, alreadyClaimed: false, message: data.error };
  return { success: false, alreadyClaimed: false, message: '未知响应' };
}

async function redeployServer(token, serverId) {
  const bodyParams = new URLSearchParams({ id: serverId });
  const response = await fetch('https://api.pella.app/server/redeploy', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://www.pella.app',
      'Referer': 'https://www.pella.app/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: bodyParams.toString()
  });

  if (!response.ok) return { success: false, message: `HTTP异常 ${response.status}` };
  
  const responseText = await response.text();
  if (!responseText) return { success: true, message: '重启指令已发送' };

  try {
    const data = JSON.parse(responseText);
    if (data.success || data.message === 'success' || response.status === 200) {
       return { success: true, message: '重启指令已发送' };
    }
    if (data.error) return { success: false, message: data.error };
    return { success: false, message: '未知响应' };
  } catch {
    return { success: true, message: '重启指令已发送' };
  }
}

async function sendTelegramNotification(env, results) {
  const message = formatNotificationMessage(results);
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TG_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    })
  });
}

function formatNotificationMessage(results) {
  const lines = ['📋 PellaFree 续期报告', ''];
  const now = new Date();
  
  for (const result of results) {
    lines.push(`账号: ${escapeHtml(result.email)}`);
    if (result.error) {
      lines.push(`错误: ${escapeHtml(result.error)}\n`);
      continue;
    }
    if (result.servers.length === 0) {
      lines.push('暂无服务器\n');
      continue;
    }
    
    for (const server of result.servers) {
      const statusText = server.status === 'running' ? '运行中' : '已关机';
      lines.push(`${statusText} | IP: <code>${server.ip || 'N/A'}</code>`);
      const remainingTime = calcRemaining(server.expiry, now);
      if (server.beforeExpiry && server.beforeExpiry !== server.expiry) {
        const beforeRemaining = calcRemaining(server.beforeExpiry, now);
        lines.push(`剩余: ${beforeRemaining} → ${remainingTime} [已续期]`);
      } else {
        lines.push(`剩余: ${remainingTime}`);
      }
      lines.push(`广告: ${server.currentUnclaimedLinks}/${server.totalLinks} 可用`);
    }
    
    const actualRenews = result.renewResults.filter(r => !r.skipped && !r.isRedeploy);
    const redeploys = result.renewResults.filter(r => r.isRedeploy);

    if (actualRenews.length > 0) {
      const successCount = actualRenews.filter(r => r.success).length;
      lines.push(`续期: ${successCount}/${actualRenews.length} 成功`);
      for (const r of actualRenews.filter(r => !r.success)) lines.push(`  失败: ${escapeHtml(r.message)}`);
    } else {
      lines.push(`续期: 无可用广告`);
    }

    if (redeploys.length > 0) {
      const successCount = redeploys.filter(r => r.success).length;
      lines.push(`重启: ${successCount}/${redeploys.length} 成功`);
      for (const r of redeploys.filter(r => !r.success)) lines.push(`  重启失败: ${escapeHtml(r.message)}`);
    }
    lines.push('');
  }
  
  lines.push('────────────────────');
  lines.push('PellaFree Actions Auto Renewal');
  lines.push(`${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  return lines.join('\n');
}

function calcRemaining(expiry, now) {
  if (!expiry) return 'N/A';
  try {
    const match = expiry.match(/(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return 'N/A';
    const [, hour, minute, second, day, month, year] = match;
    const expiryDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    const diff = expiryDate.getTime() - now.getTime();
    if (diff <= 0) return '已过期';
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (days > 0) return `${days}天${hours}时${minutes}分`;
    if (hours > 0) return `${hours}时${minutes}分`;
    return `${minutes}分`;
  } catch {
    return 'N/A';
  }
}

function extractCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 自动执行入口，读取 process.env 环境变量
(async () => {
  await main(process.env);
})();
