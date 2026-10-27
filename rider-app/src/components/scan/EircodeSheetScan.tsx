import { Modal } from 'react-native';
import AddressScan from './AddressScan';

type Props = {
  visible: boolean;
  /** The Eircodes the rider picked, in the order they are on the sheet. */
  onEircodes: (codes: string[]) => void;
  onTypeInstead: () => void;
  onClose: () => void;
};

/**
 * Sheet scan: one photo of a page with many Eircodes (a list, a printout, a screen). Every Eircode found gets a box;
 * the rider taps the ones to add, or Select all. The codes then go through the same checks as an imported file.
 */
export default function EircodeSheetScan({ visible, onEircodes, onTypeInstead, onClose }: Props) {
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      {visible ? <AddressScan kind="eircodes" onEircodes={onEircodes} onTypeInstead={onTypeInstead} onClose={onClose} modeSwitch={null} /> : null}
    </Modal>
  );
}
