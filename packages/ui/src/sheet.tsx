import { useEffect, useRef, type ReactNode } from 'react'
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { radius, space, type, useBottomInset, useColors } from './theme.ts'

export type SheetAction = {
  label: string
  Icon?: (p: { color: string; size?: number }) => ReactNode
  onPress: () => void
}

/**
 * A short list of choices that slides up from the bottom, as the Farcaster client's recast
 * menu does: the page dims, the sheet rises, and tapping outside or Cancel closes it. Each
 * choice closes the sheet before it runs.
 */
export const ActionSheet = ({ open, onClose, actions }: { open: boolean; onClose: () => void; actions: SheetAction[] }) => {
  const c = useColors()
  const bottom = useBottomInset()
  const rise = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (open) {
      rise.setValue(0)
      Animated.timing(rise, { toValue: 1, duration: 220, useNativeDriver: Platform.OS !== 'web' }).start()
    }
  }, [open, rise])
  const translateY = rise.interpolate({ inputRange: [0, 1], outputRange: [320, 0] })
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.backdrop} onPress={onClose} />
        <Animated.View accessibilityViewIsModal
          style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border, paddingBottom: bottom + space.md, transform: [{ translateY }] }]}>
          <View style={[styles.grabber, { backgroundColor: c.border }]} />
          {actions.map(a => (
            <Pressable key={a.label} accessibilityRole="button" accessibilityLabel={a.label}
              onPress={() => { onClose(); a.onPress() }}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.pressed }]}>
              {a.Icon && <a.Icon color={c.text} size={20} />}
              <Text style={[type.body, { color: c.text, fontWeight: '600' }]}>{a.label}</Text>
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={onClose}
            style={({ pressed }) => [styles.cancel, { backgroundColor: pressed ? c.pressed : c.field }]}>
            <Text style={[type.body, { color: c.text, fontWeight: '600' }]}>Cancel</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.xs,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderBottomWidth: 0,
  },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: radius.full, marginBottom: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 52, paddingHorizontal: space.md, borderRadius: radius.md },
  cancel: { alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: radius.full, marginTop: space.sm },
})
