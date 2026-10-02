// Native Android builds can use a local Firebase messaging config without Expo's push service.
export default ({ config }) => ({
  ...config,
  plugins: [...(config.plugins || []), ["expo-secure-store", { configureAndroidBackup: true }]],
  android: {
    ...config.android,
    ...(process.env.GOOGLE_SERVICES_FILE
      ? { googleServicesFile: process.env.GOOGLE_SERVICES_FILE }
      : {}),
  },
});
