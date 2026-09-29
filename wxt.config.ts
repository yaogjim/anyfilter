import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  extensionApi: 'chrome',
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'AnyFilter',
    description:
      'Hide anything, on any site. Hides ads, engagement bait, promos, platitudes, hate, spam bots and anything you describe, and shows you what it hid. X first, more sites coming. Bring your own Jev API key.',
    version: '0.4.0.0',
    permissions: ['storage', 'sidePanel'],
    host_permissions: [
      'https://x.com/*',
      'https://ai-gateway.vercel.sh/*',
      'https://api.typesafe.ai/*',
      // Only used by the opt-in real-quality evaluation, with keys the person types in.
      'https://api.openai.com/*',
      'https://api.deepseek.com/*',
      // The OpenAI labeller may be pointed at this relay from the panel. Remove the
      // line to make the relay unreachable.
      'https://api.huodale.site/*',
    ],
    action: {
      default_title: 'AnyFilter',
    },
  },
});
