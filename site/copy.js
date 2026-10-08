for (const button of document.querySelectorAll('[data-copy]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const text = button.parentElement.querySelector('code').textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = document.documentElement.lang === 'zh-CN' ? '已复制' : 'Copied';
    } catch {
      button.textContent = document.documentElement.lang === 'zh-CN' ? '请选中命令复制' : 'Select the command to copy';
    }
  });
}
