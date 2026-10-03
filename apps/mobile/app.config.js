// Native Android builds can use a local Firebase messaging config without Expo's push service.
export default ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins || []),
    ["expo-secure-store", { configureAndroidBackup: true }],
    [
      "./plugins/with-local-android.cjs",
      {
        apiUrl: process.env.EXPO_PUBLIC_API_URL || "http://10.0.2.2:8787",
      },
    ],
  ],
  android: {
    ...config.android,
    ...(process.env.GOOGLE_SERVICES_FILE
      ? { googleServicesFile: process.env.GOOGLE_SERVICES_FILE }
      : {}),
  },
});
