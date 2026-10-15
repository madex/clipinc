const fs = require('fs');
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const { merge } = require('webpack-merge');

const outputPath = path.join(__dirname, 'dist');

fs.rmSync(outputPath, { recursive: true, force: true });

/** @type {(env: Record<string, string>) => import("webpack").Configuration} */
function getCommonConfig(env) {
    const isDevelopment = Boolean(env.development);

    return {
        mode: isDevelopment ? 'development' : 'production',
        devtool: isDevelopment ? 'cheap-module-source-map' : false,
        resolve: { extensions: ['.js', '.jsx', '.ts', '.tsx'] },
        module: {
            rules: [
                {
                    test: /\.(js|jsx|ts|tsx)$/,
                    use: 'babel-loader',
                    exclude: /node_modules/,
                },
                {
                    test: /\.css$/i,
                    use: [MiniCssExtractPlugin.loader, 'css-loader'],
                },
                {
                    test: /\.(png|jpg|gif)$/i,
                    use: [
                        {
                            loader: 'url-loader',
                            options: {
                                limit: 8192,
                            },
                        },
                    ],
                },
            ],
        },
        plugins: [new MiniCssExtractPlugin()],
    };
}

module.exports = [
    // 1. Popup (unchanged)
    function popup(env) {
        return merge(getCommonConfig(env), {
            entry: { popup: './popup/index.js' },
            output: { path: path.join(outputPath, 'popup') },
            plugins: [
                new HtmlWebpackPlugin({
                    template: './popup/index.html',
                }),
                new MiniCssExtractPlugin(),
            ],
        });
    },
    // 2. Content scripts (unchanged)
    function content(env) {
        return merge(getCommonConfig(env), {
            entry: {
                content: './content/content.js',
                inject: './content/inject.js',
            },
            output: { path: path.join(outputPath, 'content') },
        });
    },
    // 3. Service Worker (replaces old backgroundPage)
    function serviceWorker(env) {
        return merge(getCommonConfig(env), {
            entry: { index: './service-worker/index.js' },
            output: { path: path.join(outputPath, 'service-worker') },
            plugins: [
                new CopyPlugin({
                    patterns: [
                        { from: 'manifest.json', to: '../manifest.json' },
                        { from: './assets/**/*', to: '..' },
                        { from: './_locales/**/*', to: '..' },
                    ],
                }),
            ],
        });
    },
    // 4. Offscreen Document (new for MV3)
    function offscreen(env) {
        return merge(getCommonConfig(env), {
            entry: { offscreen: './offscreen/offscreen.js' },
            output: { path: path.join(outputPath, 'offscreen') },
            plugins: [
                new HtmlWebpackPlugin({
                    template: './offscreen/offscreen.html',
                }),
                new CopyPlugin({
                    patterns: [
                        {
                            from: './background-page/encoders/*',
                            to: './encoders/[name][ext]',
                        },
                    ],
                }),
            ],
        });
    },
];
