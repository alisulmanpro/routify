import { Screen } from '../components/Kit';
import DeliveryWizard from '../components/DeliveryWizard';
import { premium as c } from '../lib/theme';
import { useNav } from '../lib/nav';

/** Voice entry: the rider speaks each detail in turn and can correct the text before saving. */
export default function VoiceEntry({ onCreated }: { onCreated: () => void }) {
  const { goBack } = useNav();
  return (
    <Screen style={{ backgroundColor: c.background }}>
      <DeliveryWizard mode="voice" onCreated={onCreated} onDone={goBack} />
    </Screen>
  );
}
