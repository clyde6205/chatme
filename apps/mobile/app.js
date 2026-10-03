import React from 'react';
import { View, Text, StyleSheet, SafeAreaView } from 'react-native';

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <View>
        <Text style={styles.title}>chatmepro</Text>
        <Text style={styles.subtitle}>Running in Expo Go</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  subtitle: { fontSize: 16, color: '#666' }
});
